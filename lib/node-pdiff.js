var fs = require('fs');
var PNG = require('pngjs').PNG;
var webshot = require('webshot');
var async = require('async');
var _ = require('lodash');

var debugEnabled = false;

function isReadableStream(stream) {
	return typeof stream === "object" ? stream.readable : false;
}

function getReadStream(file) {
	return Buffer.isBuffer(file) ? file : fs.createReadStream(file);
}

function suffixFileName(file) {
	var args = Array.prototype.slice.call(arguments, 1);
	var array = file.split(".");
	var ext = array.pop();
	array = array.concat(args);
	array.push(ext);
	return array.join(".");
}

function log(message) {
	if (debugEnabled) {
		console.log(message);
	}
}

var debug = function() {
	debugEnabled = !debugEnabled;
};

/**
 * Compares two or more websites and performs a difference operation between the source url
 * and each compare.
 * @method compare
 * @param  {Object}   options Configuration object
 *   @param {String}        options.source              The url of the site that each compare will be compared to
 *   @param {String|Array}  options.compareTo           A url or array of urls to compare the source against
 *   @param {Boolean}       [options.outputScreenshots] Whether to output the individual screenshots
 *   @param {String}        [options.outputDir]         The directory to store the output files
 *   @param {String}        [options.outputFile]        The base filename for each file
 *   @param {Boolean}       [options.block]             Whether the difference should output in block mode
 *   @param {Boolean}       [options.heatmap]           Whether the difference should output in heatmap mode
 *   @param {Object}        [webshotOptions]            Webshot options. Refer to the node-webshot API
 * @param  {Function}  cb     Callback
 */
var compare = function(options, cb) {
	var callback = cb || function() {};
	var shots;

	if (!options.source || !options.compareTo) { return; }

	var config = _.extend({
		outputScreenshots: false,
		outputDir: ".",
		outputFile: "output.png",
		block: false,
		heatmap: false,
		threshold: 0,
	}, options);

	config.outputDir += "/";

	var imageData = [];

	var captureOptions = {
		callback: function(err, data) {
			imageData.push(data);
		},
		options: _.extend({
			screenSize: {
				width: 1028,
				height: 768
			},
			shotSize: {
				width: 'all',
				height: 'all'
			}
		}, config.webshotOptions || {})
	};

	if (Array.isArray(config.compareTo)) {
		shots = [config.source].concat(config.compareTo);
	} else {
		shots = [config.source, config.compareTo];
	}

	shots = shots.map(function(shot) {
		return _.extend({url: shot}, captureOptions);
	});

	capture(shots, function(err, data) {
		var x = 1;

		if (config.outputScreenshots) {
			data.forEach(function(buffer, i) {
				var path = config.outputDir + suffixFileName(config.outputFile, i, "screen");
				log("Writing screenshot " + path);
				fs.writeFileSync(path, buffer);
			});
		}

		var src = data.shift();
		var i = 0;
		var pngStreams = [];

		var iterator = function(stream, done) {
			log("Performing difference between " + config.source + " and " + config.compareTo[i++]);

			difference({
				block: config.block,
				heatmap: config.heatmap,
				threshold: config.threshold,
				imageFiles: [src, stream],
				outputFile: config.outputDir + suffixFileName(config.outputFile, x++, "diff"),
				callback: function(png, data) {
					pngStreams.push({
						data: data,
						png: png
					});
					done();
				}
			});
		};

		async.eachSeries(data, iterator, function() {
			if (_.isFunction(cb)) {
			 	cb(pngStreams);	
			}
		});
	});
};

/**
 * Performs a screenshot for a single shot or array of shots
 * @method  capture
 * @param  {Object|Array}   shots Configuration object for a shot
 * @param  {Function}       cb    Callback
 */
var capture = function(shots, cb) {
	var callback = cb || function() {};
	var data = [];
	
	var getArgs = function(shot) {
		var args = [];
		args.push(shot.url);
		
		if (shot.output) {
			args.push(shot.output);
		}

		if (shot.options) {
			args.push(shot.options);
		}
		
		args.push(shot.callback);
		return args;
	};

	var takeShot = function(shot, done) {
		if (!shot.callback) {
			shot.callback = function() {};
		}

		if (!shot.onData) {
			shot.onData = function() {};
		}

		shot.callback = _.wrap(shot.callback, function(fn, err, stream) {
			if (stream) {
				var buffer = new Buffer(0);

				log("Capturing " + shot.url);

				stream.on("data", function(imageData) {
					shot.onData(imageData);
					buffer = Buffer.concat([buffer, imageData]);
					log(buffer.length);
				});

				stream.on("end", function() {
					data.push(buffer);
					fn(err, buffer);
					log("Capture end");
					done();
				});
			} else {
				fn(err);
				done();
			}
			
		});

		webshot.apply(this, getArgs(shot));
	};

	if (Array.isArray(shots)) {
		async.eachSeries(shots, takeShot, function(err) {
			log("Done capturing");
			callback(err, data);
		});
	} else {
		webshot.apply(this, getArgs(shots));
	}
};

/**
 * Performs an image difference comparison between two PNG files
 * @method
 * @param  {Object} options Options
 *   @param {String}   [options.outputFile=output.png] Difference output file
 *   @param {Number}   [options.threshold=0]           The threshold for pixels to appear different 0 - 255
 *   @param {Boolean}  [options.block=false]           Whether the difference outputs in block mode
 *   @param {Boolean}  [options.heatmap=false]         Whether the output is in heatmap mode
 *   @param {Array}    options.imageFile               An array of two paths or Buffers containing the 
 *                                                     image data to be compared
 *   @param {Function} [options.callback]              Callback
 */
var difference = function(options) {
	var dataOutput = {
		numberOfDifferentPixels: 0,
		numberOfSamePixels: 0,
		totalPixels: 0,
		differenceRatio: 0
	};

	var config = {
		outputFile: "output.png",
		threshold: 0,
		block: false,
		heatmap: false,
		imageFiles: [],
		callback: function() {}
	};

	for (option in options) {
		if (options.hasOwnProperty(option)) {
			config[option] = options[option];
		}
	}

	config.dataOutput = config.outputFile + ".json";

	var png1 = new PNG({filterType: -1});
	var png2 = new PNG({filterType: -1});
	var outputPng;
	var output = null;
	var src1 = getReadStream(config.imageFiles[0]);

	if (!config.getDataStream) {
		output = fs.createWriteStream(config.outputFile);
	}

	png1.on("parsed", function() {
		var src2 = getReadStream(config.imageFiles[1]);

		outputPng = new PNG({
			filterType: -1,
			width: this.width,
			height: this.height
		});

		this.bitblt(outputPng, 0, 0, this.width, this.height, 0, 0);
		
		if (Buffer.isBuffer(src2)) {
			png2.parse(src2);
		} else {
			src2.pipe(png2);
		}
	});

	png2.on("parsed", function() {
		for (var y = 0; y < this.height; y++) {
			for (var x = 0; x < this.width; x++) {
				var idx = (this.width * y + x) << 2;

				var r = Math.abs(outputPng.data[idx] - this.data[idx]); 
				var g = Math.abs(outputPng.data[idx + 1] - this.data[idx + 1]); 
				var b = Math.abs(outputPng.data[idx + 2] - this.data[idx + 2]); 

				if (r <= config.threshold || 
				    g <= config.threshold || 
				    b <= config.threshold) {

					dataOutput.numberOfSamePixels++;
				} else {
					if (config.heatmap) {
						var maxValue = Math.max(r, g, b);
						r = maxValue;
						g = maxValue;
						b = 0;
					} else if (config.block) {
						r = 255;
						g = 255;
						b = 0
					}

					dataOutput.numberOfDifferentPixels++;
				}
				outputPng.data[idx] = r;
				outputPng.data[idx + 1] = g;
				outputPng.data[idx + 2] = b;

				dataOutput.totalPixels++;
			}
		}

		dataOutput.config = _.omit(config, "imageFiles");
		dataOutput.differenceRatio = dataOutput.numberOfDifferentPixels / dataOutput.totalPixels;
		
		outputPng.pack();

		if (config.outputFile) {
			log("Writing file " + config.dataOutput);
			fs.writeFileSync(config.dataOutput, JSON.stringify(dataOutput, null, "\t"));
			log("Piping output stream to " + config.outputFile);
			outputPng.pipe(output);
		}

		config.callback(outputPng, config.dataOutput);
	
	});

	if (Buffer.isBuffer(src1)) {
		png1.parse(src1);
	} else {
		src1.pipe(png1);
	}

} 

module.exports.difference = difference;
module.exports.capture = capture;
module.exports.compare = compare;
module.exports.debug = debug;


