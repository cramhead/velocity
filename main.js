/*jshint -W117, -W030 */
/* global
 Velocity:true,
 DEBUG:true
 */

DEBUG = !!process.env.VELOCITY_DEBUG;
Velocity = {};

(function () {
  'use strict';

//////////////////////////////////////////////////////////////////////
// Init
//

  if (process.env.NODE_ENV !== 'development' || process.env.IS_MIRROR) {
    DEBUG && console.log('Not adding velocity code');
    return;
  }

  var _ = Npm.require('lodash'),
      fs = Npm.require('fs'),
      readFile = Meteor._wrapAsync(fs.readFile),
      writeFile = Meteor._wrapAsync(fs.writeFile),
      path = Npm.require('path'),
      Rsync = Npm.require('rsync'),
      freeport = Npm.require('freeport'),
      child_process = Npm.require('child_process'),
      spawn = child_process.spawn,
      chokidar = Npm.require('chokidar'),
      glob = Npm.require('glob'),
      _config,
      _testFrameworks,
      _watcher,
      FIXTURE_REG_EXP = new RegExp("-fixture.(js|coffee)$"),
      DEFAULT_FIXTURE_PATH = process.env.PWD + path.sep + 'packages' + path.sep + 'velocity' + path.sep + 'default-fixture.js';

  Meteor.startup(function initializeVelocity () {
    DEBUG && console.log('[velocity] PWD', process.env.PWD);

    _config = _loadTestPackageConfigs();
    _testFrameworks = _.pluck(_config, function (config) {
      return config.name;
    });
    DEBUG && console.log('velocity config =', JSON.stringify(_config, null, 2));

    // kick-off everything
    _reset(_config);
  });

//////////////////////////////////////////////////////////////////////
// Public Methods
//

  _.extend(Velocity, {

    getMirrorPath: function () {
      return path.join(process.env.PWD, '.meteor', 'local', '.mirror');
    },

    getTestsPath: function () {
      return path.join(process.env.PWD, 'tests');
    }
  });

//////////////////////////////////////////////////////////////////////
// Meteor Methods
//

  Meteor.methods({

    /**
     * Meteor method: reset
     * Re-init file watcher and clear all test results.
     *
     * @method reset
     */
    reset: function () {
      _reset(_config);
    },

    /**
     * Meteor method: resetReports
     * Clear all test results.
     *
     * @method resetReports
     * @param {Object} [options] Optional, specify specific framework to clear
     *                 and/or define a list of tests to keep.
     *                 ex.
     *                 {
     *                   framework: 'jasmine-unit',
     *                   notIn: ['tests/auth-jasmine-unit.js']
     *                 }
     */
    resetReports: function (options) {
      var query = {};
      if (options.framework) {
        query.framework = options.framework;
      }
      if (options.notIn) {
        query = _.assign(query, {_id: {$nin: options.notIn }});
      }
      VelocityTestReports.remove(query);
      _updateAggregateReports();
    },

    /**
     * Meteor method: resetLogs
     * Clear all log entried.
     *
     * @method resetLogs
     * @param {Object} [options] Optional, specify specific framework to clear
     */
    resetLogs: function (options) {
      var query = {};
      if (options.framework) {
        query.framework = options.framework;
      }
      VelocityLogs.remove(query);
    },

    /**
     * Meteor method: postLog
     * Log a method to the central Velocity log store.
     *
     * @method postLog
     * @param {Object} options Required parameters:
     *                   type - String
     *                   message - String
     *                   framework - String  ex. 'jasmine-unit'
     *
     *                 Optional parameters:
     *                   timestamp - Date
     */
    postLog: function (options) {
      var requiredFields = ['type', 'message', 'framework'];

      _checkRequired(requiredFields, options);

      VelocityLogs.insert({
        timestamp: options.timestamp ? options.timestamp : Date.now(),
        type: options.type,
        message: options.message,
        framework: options.framework
      });
    },

    /**
     * Meteor method: postResult
     * Record the results of a test run.
     *
     * @method postResult
     * @param {Object} data Required fields:
     *                   id - String
     *                   name - String
     *                   framework - String  ex. 'jasmine-unit'
     *                   result - String.  ex. 'failed', 'passed'
     *
     *                 Suggested fields:
     *                   timestamp
     *                   time
     *                   async
     *                   timeOut
     *                   pending
     *                   failureType
     *                   failureMessage
     *                   failureStackTrace
     *                   ancestors
     */
    postResult: function (data) {
      var requiredFields = ['id', 'name', 'framework', 'result'];

      data = data || {};

      _checkRequired(requiredFields, data);

      VelocityTestReports.upsert(data.id, {$set: data});
      _updateAggregateReports();
    },  // end postResult

    /**
     * Meteor method: completed
     * Frameworks must call this method to inform Velocity they have completed
     * their current test runs. Velocity uses this flag when running in CI mode.
     *
     * @method completed
     * @param {Object} data Required fields:
     *                   framework - String  ex. 'jasmine-unit'
     */
    completed: function (data) {
      var requiredFields = ['framework'];

      data = data || {};

      _checkRequired(requiredFields, data);

      VelocityAggregateReports.upsert({'name': data.framework}, {$set: {'result': 'completed'}});
      _updateAggregateReports();
    },  // end completed

    /**
     * Meteor method: copySampleTests
     * Copy sample tests from frameworks `sample-tests` directories
     * to user's `app/tests` directory.
     *
     * @method copySampleTests
     * @param {Object} options
     *     ex. {framework: 'jasmine-unit'}
     */
    copySampleTests: function (options) {
      var pwd = process.env.PWD,
          samplesPath,
          testsPath,
          command;

      options = options || {};

      if (!options.framework) {
        return;
      }

      samplesPath = path.join(pwd, 'packages', options.framework, 'sample-tests');
      testsPath = path.join(pwd, 'tests');

      DEBUG && console.log('[velocity] checking for sample tests in', path.join(samplesPath, '*'));

      if (fs.existsSync(samplesPath)) {
        command = 'mkdir -p ' + testsPath + ' && ' +
          'rsync -au ' + path.join(samplesPath, '*') +
          ' ' + testsPath + path.sep;

        DEBUG && console.log('[velocity] copying sample tests (if any) for framework', options.framework, '-', command);

        child_process.exec(command, function (err, stdout, stderr) {
          if (err) {
            console.log('ERROR', err);
          }
          console.log(stdout);
          console.log(stderr);
        });
      }
    },  // end copySampleTests

    /**
     * Meteor method: velocityStartMirror
     *
     * Starts a mirror and copies any specified fixture files into the mirror.
     * TODO and will remove any registered frameworks and reporters from the mirror
     *
     * @method velocityStartMirror
     * @param {Object} options Required fields:
     *                   name - String ex. 'mocha-web-1'
     *
     *                 Optional parameters:
     *                   fixtureFiles - Array of files with absolute paths
     *                   port - String use a specific port instead of finding the next available one
     *
     * @return the url of started mirror
     */
    velocityStartMirror: function (options) {

      check(options, {
        name: String,
        port: Match.Optional(Number),
        fixtureFiles: Match.Optional(Array)
      });

      var mirror_base_path = Velocity.getMirrorPath(),
          mongo_port = process.env.MONGO_URL.replace(/.*:(\d+).*/, '$1'),
          port = options.port ? options.port : Meteor._wrapAsync(freeport)();

      if (options.fixtureFiles) {
        _.each(options.fixtureFiles, function (fixtureFile) {
          VelocityFixtureFiles.insert({
            _id: fixtureFile,
            absolutePath: fixtureFile
          });
        });
      }

      var opts = {
        cwd: mirror_base_path,
        stdio: 'pipe',
        env: _.extend({}, process.env, {
          ROOT_URL: 'http://localhost:' + port,
          MONGO_URL: 'mongodb://127.0.0.1:' + mongo_port + '/' + options.name,
          PARENT_URL: process.env.ROOT_URL,
          IS_MIRROR: true
        })
      };

      writeFile(mirror_base_path + '/settings.json', JSON.stringify(Meteor.settings));

      DEBUG && console.log('[velocity] Starting mirror at http://localhost:' + port);

      spawn('meteor', ['--port', port, '--settings', 'settings.json'], opts);
      return 'http://localhost:' + port;

    }  // end velocityStartMirror

  });  // end Meteor methods

//////////////////////////////////////////////////////////////////////
// Private functions
//

  /**
   * Ensures that each require field is found on the target object.
   * Throws exception if a required field is undefined, null or an empty string.
   *
   * @method _checkRequired
   * @param {Array} requiredFields - list of required field names
   * @param {Object} target - target object to check
   * @private
   */
  function _checkRequired (requiredFields, target) {
    // Check target to pass 'audit-argument-checks' requirement
    check(target, Match.Any);

    _.each(requiredFields, function (name) {
      if (!target[name]) {
        throw new Error('Required field "' + name + '" is missing. ' +
          'Result not posted.');
      }
    });
  }

  /**
   * Locate all velocity-compatible test packages and return their config
   * data.
   *
   * @example
   *     // in `jasmine-unit` package's `smart.json`:
   *     {
   *       "name": "jasmine-unit",
   *       "description": "Velocity-compatible jasmine unit test package",
   *       "homepage": "https://github.com/xolvio/jasmine-unit",
   *       "author": "Sam Hatoum",
   *       "version": "0.1.1",
   *       "git": "https://github.com/xolvio/jasmine-unit.git",
   *       "test-package": true,
   *       "regex": "-jasmine-unit\\.(js|coffee)$"
   *     }
   *
   * @method _loadTestPackageConfigs
   * @return {Object} Hash of test package names and their normalized config data.
   * @private
   */
  function _loadTestPackageConfigs () {
    var pwd = process.env.PWD,
        smartJsons = glob.sync('packages/**/smart.json', {cwd: pwd}),
        testConfigDictionary;

    DEBUG && console.log('Check for test package configs...', smartJsons);

    testConfigDictionary = _.reduce(smartJsons, function (memo, smartJsonPath) {
      var contents,
          config;

      try {
        contents = readFile(path.join(pwd, smartJsonPath));
        config = JSON.parse(contents);
        if (config.name && config.testPackage) {

          // add smart.json contents to our dictionary
          memo[config.name] = config;

          if ('undefined' === typeof memo[config.name].regex) {
            // if test package hasn't defined an explicit regex for the file
            // watcher, default to the package name as a suffix.
            // Ex. name = "mocha-web"
            //     regex = "-mocha-web.js"
            memo[config.name].regex = '-' + config.name + '\\.js$';
          }

          // create a regexp obj for use in file watching
          memo[config.name]._regexp = new RegExp(memo[config.name].regex);
        }
      } catch (ex) {
        DEBUG && console.log('Error reading file:', smartJsonPath, ex);
      }
      return memo;
    }, {});

    return testConfigDictionary;
  }  // end _loadTestPackageConfigs

  /**
   * Initialize the directory/file watcher.
   *
   * @method _initWatcher
   * @param {Object} config  See `_loadTestPackageConfigs`.
   * @private
   */
  function _initWatcher (config) {

    _watcher = chokidar.watch(Velocity.getTestsPath(), {ignored: /[\/\\]\./});

    _watcher.on('add', Meteor.bindEnvironment(function (filePath) {
      var relativePath,
          targetFramework,
          data;

      filePath = path.normalize(filePath);

      DEBUG && console.log('File added:', filePath);

      relativePath = filePath.substring(process.env.PWD.length);
      if (relativePath[0] === path.sep) {
        relativePath = relativePath.substring(1);
      }

      // if this is a fixture file, put it in the fixtures collection
      if (FIXTURE_REG_EXP.test(relativePath)) {
        VelocityFixtureFiles.insert({
          _id: filePath,
          absolutePath: filePath,
          lastModified: Date.now()
        });
        return;
      }

      // test against each test framework's regexp matcher, use first
      // one that matches
      targetFramework = _.find(config, function (framework) {
        return framework._regexp.test(relativePath);
      });

      if (targetFramework) {
        DEBUG && console.log(targetFramework.name, ' <= ', filePath);

        data = {
          _id: filePath,
          name: path.basename(filePath),
          absolutePath: filePath,
          relativePath: relativePath,
          targetFramework: targetFramework.name,
          lastModified: Date.now()
        };

        //DEBUG && console.log('data', data);
        VelocityTestFiles.insert(data);
      }
    }));  // end watcher.on 'add'

    _watcher.on('change', Meteor.bindEnvironment(function (filePath) {
      DEBUG && console.log('File changed:', filePath);

      // Since we key on filePath and we only add files we're interested in,
      // we don't have to worry about inadvertently updating records for files
      // we don't care about.
      VelocityFixtureFiles.update(filePath, { $set: {lastModified: Date.now()}});
      VelocityTestFiles.update(filePath, { $set: {lastModified: Date.now()}});
    }));

    _watcher.on('unlink', Meteor.bindEnvironment(function (filePath) {
      DEBUG && console.log('File removed:', filePath);
      // If we only remove the file, we also need to remove the test results for
      // just that file. This required changing the postResult API and we could
      // do it, but the brute force method of reset() will do the trick until we
      // want to optimize VelocityTestFiles.remove(filePath);
      _reset(config);
    }));

  }  // end _initWatcher

  /**
   * Re-init file watcher and clear all test results.
   *
   * @method _reset
   * @param {Object} config  See `_loadTestPackageConfigs`.
   * @private
   */
  function _reset (config) {
    if (_watcher) {
      _watcher.close();
    }

    VelocityTestFiles.remove({});
    VelocityFixtureFiles.remove({});
    VelocityFixtureFiles.insert({
      _id: DEFAULT_FIXTURE_PATH,
      absolutePath: DEFAULT_FIXTURE_PATH
    });
    VelocityTestReports.remove({});
    VelocityLogs.remove({});
    VelocityAggregateReports.remove({});
    VelocityAggregateReports.insert({
      name: 'aggregateResult',
      result: 'pending'
    });
    VelocityAggregateReports.insert({
      name: 'aggregateComplete',
      result: 'pending'
    });
    _.each(_testFrameworks, function (testFramework) {
      VelocityAggregateReports.insert({
        name: testFramework,
        result: 'pending'
      });
    });

    // Meteor just reloaded us which means we should rsync the app files to the mirror
    _syncMirror();

    _initWatcher(config);
  }

  /**
   * If any one test has failed, mark the aggregate test result as failed.
   *
   * @method _updateAggregateReports
   * @private
   */
  function _updateAggregateReports () {

    var failedResult,
        result;

    if (!VelocityTestReports.findOne({result: ''})) {
      failedResult = VelocityTestReports.findOne({result: 'failed'});
      result = failedResult ? 'failed' : 'passed';

      VelocityAggregateReports.update({ 'name': 'aggregateResult'}, {$set: {result: result}});
    }

    // if all test frameworks have completed, upsert an aggregate completed record
    var completedFrameworksCount = VelocityAggregateReports.find({ 'name': {$in: _testFrameworks}, 'result': 'completed'}).count();

    if (_testFrameworks.length === completedFrameworksCount) {
      VelocityAggregateReports.update({'name': 'aggregateComplete'}, {$set: {'result': 'completed'}});
    }

  }

  /**
   * Creates a physical mirror of the application under .meteor/local/.mirror
   *
   *     - Any files with the pattern tests/.*  are not copied, this stops .report
   *     directory from also being copied.
   *
   *     TODO - Strips out velocity, any test packages and reporters from the mirror's .meteor/packages file
   *
   * @method _syncMirror
   * @private
   */
  function _syncMirror () {
    var cmd = new Rsync()
      .shell('ssh')
      .flags('av')
      .set('delete')
      .set('q')
      .set('delay-updates')
      .set('force')
      .exclude('.meteor/local')
      .exclude('tests/.*')
      .source(process.env.PWD + path.sep)
      .destination(Velocity.getMirrorPath());
    var then = Date.now();
    cmd.execute(Meteor.bindEnvironment(function (error) {

      if (error) {
        DEBUG && console.error('[velocity] Error syncing mirror', error);
      } else {
        DEBUG && console.log('[velocity] rsync took', Date.now() - then);
      }
      // TODO remove this once jasmine and mocha-web are using the new method
      Meteor.call('velocityStartMirror', {
        name: 'mocha-web',
        port: 5000
      });

    }));
  }

})();
