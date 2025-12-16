const util = require('util')
const PLUGIN_ID = 'signalk-bandg-displaydayNight';
const PLUGIN_NAME = 'Auto adjust B&G display mode';
var sourceAddress = 1; // Gets overwritten by candevice
var networkGroups = {
  'Default' : '01',
  '1'       : '02',
  '2'       : '03',
  '3'       : '04',
  '4'       : '05',
  '5'       : '06',
  '6'       : '07'}

var unsubscribes = [];

var lastState = {};

module.exports = function(app) {
  var plugin = {};
  var ws;


  plugin.id = PLUGIN_ID;
  plugin.name = PLUGIN_NAME;
  plugin.description = 'A plugin that auto adjusts B&G display mode';

  plugin.start = function(options, restartPlugin) {
    plugin.options = options;
    app.debug('Plugin started');
    app.debug('Schema: %s', JSON.stringify(options));
    
    // Local state variables
    var runMode = 'mode';
    
    // Cache for the last command sent per group
    // Structure: { 'Default': { mode: 'day', level: 10 } }
    var lastSentSettings = {}; 

    // Tracker for Resync Activity
    // Structure: { 'Group_Source_Path': timestamp_ms }
    var activityTracker = {};

    //api for adjustments
    app.registerPutHandler('vessels.self', 'environment.displayMode.control', doChangeDisplayMode, PLUGIN_ID);

    let localSubscription = {
      context: 'vessels.self',
      subscribe: [
      {
        path: 'environment.mode'         // For mode based
      },
      {
        path: 'environment.sun'          // For sun based
      }
      ]
    }

    // Build subscriptions based on config
    if (typeof options.config != 'undefined') {
      options.config.forEach(config => {
        // Lux subscription
        if (config.Lux && config.Lux['path']) {
          localSubscription.subscribe.push({
            path: config.Lux['path']
          })
        }

        // Resync Trigger subscription
        if (config.Resync && Array.isArray(config.Resync)) {
          config.Resync.forEach(trigger => {
            if (trigger.path && trigger.path.length > 0) {
              app.debug(`Adding monitor subscription for group ${config.group}: ${trigger.path}`);
              localSubscription.subscribe.push({
                path: trigger.path
              });
            }
          });
        }
      })
    }

    app.subscriptionmanager.subscribe(
      localSubscription,
      unsubscribes,
      subscriptionError => {
        app.error('Error:' + subscriptionError);
      },
      delta => {
        delta.updates.forEach(u => {
          app.debug('delta sub: %s', JSON.stringify(u))
		  var path = u['values'][0]['path']
          var value = u['values'][0]['value']
          var source = u['source'] ? u['source']['label'] : delta.source ? delta.source.label : 'unknown'; 
          
          options.config.forEach(config => {
            var group = config.group;
            app.debug(`RunMode: ${runMode}, group: ${group}`)

            // --------------------------------------------------------
            // Resync Logic
            // --------------------------------------------------------
            if (config.Resync && Array.isArray(config.Resync)) {
              app.debug('in first if')
				config.Resync.forEach(trigger => {
                // Check if this delta matches the trigger path
				app.debug('in second if')
                if (trigger.path === path) {
                  // Check if source matches (if configured)
					app.debug('in third if')
                  if (trigger.source && trigger.source !== '' && trigger.source !== source) {
                    app.debug(`Trigger source ${trigger.source} did not match saved source ${source}`)
					  return; // Source didn't match
                  }
				  app.debug('Trigger delta received, updated last-seen time');
					
                  // Generate unique key for this specific trigger instance
				  // Recall the timestamp of the last transmission. If the next transmission occures after more than 'timeout',
				  // it is assumed the device is powered off and the backlighting values for 'now' should be sent
                  var trackerKey = `${group}_${source}_${path}`;
                  var now = Date.now();
                  var lastSeen = activityTracker[trackerKey];
                  var timeoutMs = (trigger.timeout || 60) * 1000;

				  // If never seen, or timeout expired
                  if (!lastSeen || (now - lastSeen > timeoutMs)) {
                    app.debug(`Resync Triggered for Group ${group}. Device ${source} on ${path} active after ${lastSeen ? (now-lastSeen)/1000 : 'infinite'}s silence.`);
                     
                    // Force resend of last known settings
                    if (lastSentSettings[group]) {
                      var settings = lastSentSettings[group];
                      app.debug(`Resending cached settings: Mode ${settings.mode}, Level ${settings.level}`);
                       
                      // We call the raw N2K senders directly to avoid loop/logic checks
                      setDisplayMode(settings.mode, group);
                      setBacklightLevel(settings.level, group);
                    } else {
                      app.debug(`Cannot Resync: No settings have been calculated yet for group ${group}`);
                	}
                  }

                  // Update activity timestamp
                  activityTracker[trackerKey] = now;
                }
              });
            }
            // --------------------------------------------------------
            // End Resync Logic
            // --------------------------------------------------------

            //always use external control if selected
            if (config.source == 'none')
              return;
        
            if (config.source == 'lux' && config.Lux && path == config.Lux.path) { 
              app.debug(`Switching to runMode \'lux\', luxPath: ${config.Lux['path']}`)
              runMode = 'lux'
            }
            
	          switch (runMode) {
	            case 'mode':
	              if (path != 'environment.mode') break;
	              var dayNight = value

                  if (config.Mode['updateOnce']) {
                    if (dayNight == lastState[group]) break
                    lastState[group] = dayNight
                  }

			      if (dayNight == 'night') {
                    executeCommand(dayNight, config.Mode['nightLevel'], group);
			      } else {
                    executeCommand(dayNight, config.Mode['dayLevel'], group);
	              }
                  
                  if (config['source'] != 'mode') { 
                    app.debug('Used backup mode \'mode\', switching to \'sun\'')
                    runMode = 'sun'
                  }
	              break;

	            case 'sun':
	              if (path != 'environment.sun') break;
	              var sunMode = value
		          app.debug('environment.sun: %s', sunMode);

	              if (!config.Sun[sunMode]) break; // Safety check

	              var mode = config.Sun[sunMode]['mode'];

                  if (config.Sun['updateOnce']) {
                    if (sunMode == lastState[group]) break
                    lastState[group] = sunMode
                  }

	              var backlightLevel = config.Sun[sunMode]['backlight'];
                  executeCommand(mode, backlightLevel, group);
	              break;

	            case 'lux':
                  if (!config.Lux) break;
	              if (path != config.Lux.path) break;
                  config.Lux.table.forEach(element => {
                    if (Number(value) >= Number(element.luxMin) && Number(value) <= Number(element.luxMax)) {
                      var mode = element.dayNight
                      var backlightLevel = element.backlightLevel
                      executeCommand(mode, backlightLevel, group);
                    }
                  })
	              break;
	          }
          })
        })
      }
    );

    // Helper Function to Centralize Sending and Caching
    function executeCommand(mode, level, group) {
        // Cache this simply
        lastSentSettings[group] = { mode: mode, level: level };
        
        app.debug(`Executing command for Group ${group}: Mode=${mode}, Level=${level}`);
        setDisplayMode(mode, group);
        setBacklightLevel(level, group);
        sendUpdate(mode, level);
    }
    
    function doChangeDisplayMode(context, path, value, callback)
    {
      app.debug("Change Display Mode PUT: " + JSON.stringify(value))
  
      if (!(value.group in networkGroups))
        value.group = 'Default';

      // Update cache manually if PUT request is used
      if (!lastSentSettings[value.group]) lastSentSettings[value.group] = {};

      if (['day', 'night'].includes(value.mode))
      {
        lastSentSettings[value.group].mode = value.mode;
        setDisplayMode(value.mode, value.group)
      }
      
      if (parseInt(value.backlight) >= 1 && parseInt(value.backlight) <= 10)
      {
        lastSentSettings[value.group].level = parseInt(value.backlight);
        setBacklightLevel(parseInt(value.backlight), value.group)
      }

      return { state: 'COMPLETED', statusCode: 200 };
    }    
    
    function sendN2k(msgs) {
      app.debug("n2k_msg: " + msgs)
      msgs.map(function(msg) { app.emit('nmea2000out', msg)})
    }

    function padd(n, p, c)
    {
      var pad_char = typeof c !== 'undefined' ? c : '0';
      var pad = new Array(1 + p).join(pad_char);
      return (pad + n).slice(-pad.length);
    }

    function intToHex(integer) {
      var hex = padd((integer & 0xff).toString(16), 2)
      return hex
    }

    function setDisplayMode(mode, group) {
      app.debug('setDisplayMode: Using group: %s (%s)', group, networkGroups[group])
      var PGN130845_dayNight = "%s,3,130845,%s,255,0e,41,9f,ff,ff,%s,ff,ff,26,00,01,%s,ff,ff,ff"; // 02 = day, 04 = night
      if (mode == 'day') {
        var msg = util.format(PGN130845_dayNight, (new Date()).toISOString(), sourceAddress, networkGroups[group], '02');
        sendN2k([msg]);
      }
      if (mode == 'night') {
        var msg = util.format(PGN130845_dayNight, (new Date()).toISOString(), sourceAddress, networkGroups[group], '04');
        sendN2k([msg]);
      }
    }

    function setBacklightLevel(level, group) {
      app.debug('setBacklightLevel: Using group: %s (%s)', group, networkGroups[group])
      var PGN130845_backlightLevel = "%s,3,130845,%s,255,0e,41,9f,ff,ff,%s,ff,ff,12,00,01,%s,ff,ff,ff"; 
      var msg = util.format(PGN130845_backlightLevel, (new Date()).toISOString(), sourceAddress, networkGroups[group], intToHex(level*10));
      sendN2k([msg]);
    }

    function sendUpdate(mode, level) {
      var update = [{
        path: "environment.displayMode",
        value: {
          mode: mode,
          backlight: level
        }
      }]

      app.debug('Updating with: ' + JSON.stringify(update))
		  app.handleMessage(plugin.id, {
        updates: [
          {
            values: update
          }
        ]
      })
    }

    app.setPluginStatus('Running');
  };



  function listen(option) {
    let _notify = function(event) {
      app.debug('event: %j', JSON.stringify(option));
    };

    app.on(option.event, _notify);
    unsubscribes.push(() => {
      app.removeListener(option.event, _notify);
    });
  }

  plugin.stop = function() {
    app.debug('Plugin stopped');
    unsubscribes.forEach(f => f());
    app.setPluginStatus('Stopped');
  };

  plugin.schema = {
    title: PLUGIN_NAME,
    type: 'object',
    properties: {
      config: {
        type: 'array',
        title: 'Add network group configs',
        items: {
          type: 'object',
          properties: {
			      group: {
			        type: 'string',
			        title: 'Network group',
			        enum: ['Default', '1', '2', '3', '4', '5', '6'],
			        enumNames: ['Default', '1', '2', '3', '4', '5', '6'],
			        default: 'Default'
			      },
			      source: {
			        type: 'string',
			        title: 'Select which source should be used to auto adjust the displays',
			        enum: ['mode', 'sun', 'lux', 'none'],
			        enumNames: ['Mode based', 'Sun based', 'Lux based', 'None / External (Use PUT interface)'],
			        default: 'mode'
			      },
            // Resync Section
            Resync: {
              title: 'Device Power-On Resync',
              description: 'Force a settings update when a device (i.e., chartplotter) appears after being offline.',
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    title: 'Trigger Path (e.g. navigation.courseOverGround, or navigation.currentRoute.name - See README)',
                    default: ''
                  },
                  source: {
                    type: 'string',
                    title: 'Source ID (e.g. NMEA2000.115). Leave empty to match any source.',
                    default: ''
                  },
                  timeout: {
                    type: 'number',
                    title: 'Inactivity Timeout (seconds). Resend settings if data is seen after this many seconds of silence.',
                    default: 60
                  }
                }
              }
            },
			      Mode: {
			        title: 'Mode based settings',
			        description: 'Adjust the display mode based on `environment.mode` (derived-data). Below the backlight level can be set for day and night mode.',
			        type: 'object',
			        properties: {
			          updateOnce: {
			            type: 'boolean',
			            title: 'Update display mode only when environment.mode changes.',
			            default: true,
			          },
			          dayLevel: {
			            type: 'number',
			            title: 'Backlight level in day mode (1-10)',
			            default: 6,
			          },
			          nightLevel: {
			            type: 'number',
			            title: 'Backlight level in night mode (1-10)',
			            default: 3,
			          }
			        }
			      },
			      Sun: {
			        title: 'Sun based settings',
			        description: 'Adjust the display mode based on `environment.sun` (derived-data). Below the display mode and backlight level can be set for each mode.',
			        type: 'object',
			        properties: {
			          updateOnce: {
			            type: 'boolean',
			            title: 'Update display mode only when environment.sun changes.',
			            default: true,
			          },
			          dawn: {
			            type: 'object',
			            title: 'Dawn',
			            properties: {
			              mode: {
			                type: 'string',
			                title: 'Select day or night mode',
			                enum: ['day', 'night'],
			                enumNames: ['Day', 'Night'],
			                default: 'night'
			              },
			              backlight: {
			                type: 'number',
			                title: 'Backlight level in nightmode (1-10)',
			                default: 4,
			              },
			            },
			          },
			          sunrise: {
			            type: 'object',
			            title: 'Sunrise',
			            properties: {
			              mode: {
			                type: 'string',
			                title: 'Select day or night mode',
			                enum: ['day', 'night'],
			                enumNames: ['Day', 'Night'],
			                default: 'day'
			              },
			              backlight: {
			                type: 'number',
			                title: 'Backlight level in nightmode (1-10)',
			                default: 4,
			              },
			            },
			          },
			          day: {
			            type: 'object',
			            title: 'Day',
			            properties: {
			              mode: {
			                type: 'string',
			                title: 'Select day or night mode',
			                enum: ['day', 'night'],
			                enumNames: ['Day', 'Night'],
			                default: 'day'
			              },
			              backlight: {
			                type: 'number',
			                title: 'Backlight level in day mode (1-10)',
			                default: 6,
			              },
			            },
			          },
			          sunset: {
			            type: 'object',
			            title: 'Sunset',
			            properties: {
			              mode: {
			                type: 'string',
			                title: 'Select day or night mode',
			                enum: ['day', 'night'],
			                enumNames: ['Day', 'Night'],
			                default: 'day'
			              },
			              backlight: {
			                type: 'number',
			                title: 'Backlight level in nightmode (1-10)',
			                default: 4,
			              },
			            },
			          },
			          dusk: {
			            type: 'object',
			            title: 'Dusk',
			            properties: {
			              mode: {
			                type: 'string',
			                title: 'Select day or night mode',
			                enum: ['day', 'night'],
			                enumNames: ['Day', 'Night'],
			                default: 'night'
			              },
			              backlight: {
			                type: 'number',
			                title: 'Backlight level in day mode (1-10)',
			                default: 4,
			              },
			            },
			          },
			          night: {
			            type: 'object',
			            title: 'Night',
			            properties: {
			              mode: {
			                type: 'string',
			                title: 'Select day or night mode',
			                enum: ['day', 'night'],
			                enumNames: ['Day', 'Night'],
			                default: 'night'
			              },
			              backlight: {
			                type: 'number',
			                title: 'Backlight level in nightmode (1-10)',
			                default: 2,
			              },
			            },
			          },
			        },
			      },
			            
			      Lux: {
			        title: 'Lux based settings',
			        description: 'Adjust the display mode based on `environment.outside.lux`. Below the display mode and backlight level can be added per lux range.',
			        type: 'object',
			        properties: {
			          path: {
			            type: 'string',
			            title: 'Path to outside lux value',
			            default: 'environment.outside.lux'
			          },
			          table: {
			            type: 'array',
			            title: 'Table entries',
			            items: {
			              type: 'object',
			              properties: {
			                luxMin: {
			                  type: 'number',
			                  title: 'Minimal lux (lux) level'
			                },
			                luxMax: {
			                  type: 'number',
			                  title: 'Max lux (lux) level'
			                },
			                dayNight: {
			                  type: 'string',
			                  title: 'Mode',
			                  enum: ['day', 'night'],
			                  enumNames: ['Day', 'Night'],
			                  default: 'day'
			                },
			                backlightLevel: {
			                  type: 'number',
			                  title: 'Backlight level (1-10)',
			                  default: 2
			                }
			              }
			            }
			          }
			        }
			      }
          }
        }
      }
    }
  }
  return plugin
}
