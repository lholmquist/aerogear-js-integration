var path = require('path');
var url = require('url');
var util = require('util');
var fs = require('fs');
var crypto = require('crypto');
var unzip = require('unzip');
var tarball = require('tarball-extract');
var shell = require('shelljs');
var Promise = require('../scripts/promisify-streams.js');
var mkdirp = Promise.denodeify(require('mkdirp'));
var request = require('request');
var _ = require('lodash');

module.exports = function ( grunt ) {

    // checks presense of required runtime; if not present, it downloads it, checks consistency,
    // unpack and install configuration overlay and finally move it to expected location
    grunt.registerMultiTask('download', 'Download build dependencies', function() {
        var done = this.async(),
            options = this.options({
                downloadDir: './.tmp/downloads/',
                tmpDir: './.tmp/'
            }),
            data = this.data,
            downloadSrc = data.src,
            downloadBasename = path.basename( downloadSrc ),
            downloadType = path.extname( downloadSrc).substr(1).toLowerCase(),
            downloadDest = path.resolve( options.downloadDir, downloadBasename),
            checksum = data.checksum,
            checksumSrc,
            checksumType,
            checksumDest,
            tmpDir = path.resolve( options.tmpDir, temp('extract-archive-') ),
            runtimeDest = path.resolve( data.dest ),
            runtimeExtracted,
            overlay = data.overlay;

        if (checksum) {
            if (/https?:\/\//.test(checksum)) {
                checksumType = path.extname(checksum).substr(1).toLowerCase();
                checksumSrc = checksum;
            } else if (/^(md5|sha1)$/.test(checksum)) {
                checksumType = checksum;
                checksumSrc = downloadSrc + '.' + checksum;
            } else {
                throw new Error('Unsupported checksum: ' + checksum);
            }
            checksumDest = downloadDest + '.' + checksumType;
        }

        grunt.log.debug( 'Download source: ' + downloadSrc );
        grunt.log.debug( 'Download basename: ' + downloadBasename );
        grunt.log.debug( 'Download type: ' + downloadType );
        grunt.log.debug( 'Download destination: ' + downloadDest );

        var validateChecksum = function() {
            return Promise.resolve()
                .then( function() {
                    if (checksum) {
                        return download(checksumSrc, checksumDest)
                            .then(function() {
                                switch ( checksumType ) {
                                    case 'md5':     return computeChecksum( 'md5', downloadDest );
                                    case 'sha1':    return computeChecksum( 'sha1', downloadDest );
                                    default:        throw new Error('unsupported checksum type: ' + checksumType);
                                }
                            })
                            .then( function( actualChecksum ) {
                                var expectedChecksum = fs.readFileSync(checksumDest);
                                grunt.log.debug( 'Expected checksum: "' + expectedChecksum + '"');
                                grunt.log.debug( 'Actual checksum:   "' + actualChecksum + '"' );
                                return actualChecksum === expectedChecksum;
                            });
                    } else {
                        // we can't check checksum, so be optimistic and say the existing archive is just fine
                        return true;
                    }
                });
        };

        var resolveArchive = function() {
            return Promise.resolve( grunt.file.exists(downloadDest))
                .then( function( exists ) {
                    if ( exists ) {
                        return validateChecksum();
                    } else {
                        return false;
                    }
                })
                .then( function( existsAndChecksumMatches ) {
                    if ( !existsAndChecksumMatches ) {
                        grunt.log.ok( 'Downloading runtime ' + downloadSrc );
                        return download( downloadSrc, downloadDest )
                            .catch( function( err ) {
                                grunt.log.error( err );
                            });
                    } else {
                        grunt.log.debug( 'File exists and checksum matches' );
                        return;
                    }
                });
        };

        var extractRuntimeToTemporaryFolder = function() {
            return extractArchive( downloadDest, tmpDir );
        };

        var findAndCheckExtractedRuntime = function() {
            var files = shell.ls( tmpDir );
            if (files.length === 0) {
                grunt.fail.fatal('No files were extracted, that cannot be right');
            } else if (files.length > 1) {
                grunt.fail.fatal('More than one file in the archive, that is not supported at the moment: ' + util.inspect(files));
            }
            runtimeExtracted = path.resolve( tmpDir, files[0] );
            grunt.log.debug( 'Runtime was extracted to ' + runtimeExtracted );
        };

        var extractOverlay = function() {
            if (overlay) {
                grunt.log.debug( 'Installing runtime overlay ' + overlay );
                return extractArchive( overlay, runtimeExtracted );
            }
        };

        var moveExtractedRuntimeToDestination = function() {
            grunt.log.debug( 'Moving runtime to destination ' + runtimeDest);
            return moveTo( runtimeExtracted, runtimeDest )
                .then(function() {
                    if ( tmpDir ) {
                        grunt.log.debug( 'Cleaning temp directory: ' + tmpDir);
                        shell.rm( '-R', tmpDir );
                    }
                });
        };

        if ( grunt.file.exists( runtimeDest ) ) {
            grunt.log.ok( 'The runtime is already installed in ' + runtimeDest + '' );
            done();
        } else {
            resolveArchive()
                .then( extractRuntimeToTemporaryFolder )
                .then( findAndCheckExtractedRuntime )
                .then( extractOverlay )
                .then( moveExtractedRuntimeToDestination )
                .then( function() {
                    grunt.log.ok( 'The runtime successfully installed to ' + runtimeDest + '' );
                    done();
                })
                .catch( function( err ) {
                    grunt.fail.fatal( err );
                });
        }
    });

    function download( src, dest ) {
        grunt.log.debug( 'Downloading ' + src + ' to ' + dest );
        // write dots to show some progress...
        var interval = setInterval(function() {
            process.stdout.write(".");
        }, 2000);
        var clear = function() {
            clearInterval(interval);
            process.stdout.write("\n");
        };
        return mkdirp( path.dirname(dest) )
            .then(function () {
                var req = request(src);
                req.pipe( fs.createWriteStream( dest ) );
                return Promise.promisifyStream( req )
                    .then( clear )
                    .catch( clear );
            });
    }

    function computeChecksum( type, src ) {
        var hash = crypto.createHash( type ),
            stream = fs.createReadStream(src);
        grunt.log.debug('Computing md5sum for ' + src );
        return Promise.promisifyStream( stream )
            .data( function( data ) {
                hash.update(data);
            })
            .then( function() {
                return hash.digest('hex');
            });
    }

    function extractArchive( src, dest ) {
        grunt.log.debug('Extracting ' + src + ' to ' + dest);
        var type = path.extname( src ).substr(1).toLowerCase();
        switch ( type ) {
            case 'zip':     return unzipArchive( src, dest );
            case 'gz':      return untargzArchive( src, dest );
            case 'jar':     return copyTo( src, dest );
            default:        throw new Error('unsupported extraction target: ' + type );
        }
    }

    function unzipArchive( src, dest ) {
        var readStream = fs.createReadStream( src );
        var writeStream = unzip.Extract( { path: dest } );
        readStream.pipe( writeStream );
        return Promise.promisifyStream( writeStream );
    }

    function untargzArchive( src, dest ) {
        return new Promise( function( resolve, reject ) {
            new tarball.extractTarball( src, dest, function( err ) {
                if ( err ) {
                    reject( err );
                    return;
                }
                resolve();
            });
        });
    }

    function moveTo( src, dest ) {
        return mkdirp( path.dirname( dest ))
            .then(function() {
                shell.mv( src, dest );
            });
    }

    function copyTo( src, dest ) {
        return mkdirp( path.dirname( dest ))
            .then(function() {
                shell.cp( src, dest );
            });
    }

    function temp( prefix, suffix ) {
        prefix = prefix || '';
        suffix = suffix || '';
        return prefix + crypto.randomBytes(4).readUInt32LE(0) + suffix;
    }
};