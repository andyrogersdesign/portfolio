/*
 * Adaptive SCORM wrapper.
 *
 * Ships inside the exported package and runs inside the LMS. It:
 *   1. Discovers whichever API the LMS injected (SCORM 2004 = API_1484_11, 1.2 = API)
 *      by walking up the window.parent chain and checking window.opener.
 *   2. Exposes ONE small interface to the player, hiding the differences between
 *      the two SCORM versions (method names, status model, time/latency formats).
 *
 * Written as a plain global script (no modules) so it is maximally robust inside
 * an LMS iframe. It also degrades gracefully when no LMS API is present, so the
 * same player can be previewed as a normal web page.
 */
(function (global) {
  'use strict'

  var api = null
  var version = null // '2004' | '1.2'
  var sessionStart = null
  var interactionIndex = 0
  var DEBUG = true

  function log() {
    if (!DEBUG || !global.console) return
    var args = ['[SCORM ' + (version || '?') + ']']
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i])
    console.log.apply(console, args)
  }

  // --- API discovery ---------------------------------------------------------

  function scanWindow(win) {
    var tries = 0
    while (win) {
      try {
        if (win.API_1484_11) {
          version = '2004'
          return win.API_1484_11
        }
        if (win.API) {
          version = '1.2'
          return win.API
        }
      } catch (e) {
        // Cross-origin parent: stop walking this chain.
        return null
      }
      if (win.parent && win.parent !== win && tries < 12) {
        win = win.parent
        tries++
      } else {
        break
      }
    }
    return null
  }

  function discover() {
    var found = scanWindow(global)
    if (!found && global.opener) found = scanWindow(global.opener)
    return found
  }

  // --- Version-specific call routing -----------------------------------------

  function callInit() {
    return version === '2004' ? api.Initialize('') : api.LMSInitialize('')
  }
  function callSet(el, val) {
    return version === '2004'
      ? api.SetValue(el, String(val))
      : api.LMSSetValue(el, String(val))
  }
  function callGet(el) {
    return version === '2004' ? api.GetValue(el) : api.LMSGetValue(el)
  }
  function callCommit() {
    return version === '2004' ? api.Commit('') : api.LMSCommit('')
  }
  function callTerminate() {
    return version === '2004' ? api.Terminate('') : api.LMSFinish('')
  }
  function lastError() {
    if (!api) return '0'
    return version === '2004' ? api.GetLastError() : api.LMSGetLastError()
  }

  // Set a value and log any error code the LMS returns. Helps diagnose the
  // version-specific quirks we are explicitly testing for in Totara.
  function set(el, val) {
    var ok = callSet(el, val)
    var err = lastError()
    if (err && err !== '0') {
      log('SetValue rejected', el, '=', val, 'error', err)
    }
    return ok
  }

  // --- Time / latency formatting ---------------------------------------------

  // SCORM 2004 uses ISO 8601 durations (e.g. PT1M30S).
  function iso8601Duration(ms) {
    var totalSeconds = Math.max(0, ms) / 1000
    var hours = Math.floor(totalSeconds / 3600)
    var minutes = Math.floor((totalSeconds % 3600) / 60)
    var seconds = totalSeconds % 60
    var out = 'PT'
    if (hours) out += hours + 'H'
    if (minutes) out += minutes + 'M'
    // Always include seconds so the duration is never just "PT".
    out += (Math.round(seconds * 100) / 100) + 'S'
    return out
  }

  // SCORM 1.2 uses CMITimespan HHHH:MM:SS.SS.
  function cmiTimespan(ms) {
    var totalSeconds = Math.max(0, ms) / 1000
    var hours = Math.floor(totalSeconds / 3600)
    var minutes = Math.floor((totalSeconds % 3600) / 60)
    var seconds = Math.floor(totalSeconds % 60)
    var hundredths = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100)
    if (hundredths === 100) {
      hundredths = 0
    }
    return (
      pad(hours) + ':' + pad(minutes) + ':' + pad(seconds) + '.' + pad(hundredths)
    )
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n
  }

  // SCORM 2004 interaction timestamp: ISO 8601 date-time (second precision).
  function iso8601DateTime(date) {
    return (
      date.getFullYear() +
      '-' + pad(date.getMonth() + 1) +
      '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) +
      ':' + pad(date.getMinutes()) +
      ':' + pad(date.getSeconds())
    )
  }

  // SCORM 1.2 interaction time: CMITime HH:MM:SS (time of day).
  function cmiTime(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  }

  // --- Public interface ------------------------------------------------------

  var SCORM = {
    init: function () {
      api = discover()
      if (!api) {
        log('No LMS API found. Running in preview mode (no tracking).')
        return false
      }
      var ok = callInit()
      sessionStart = new Date()
      log('Initialize ->', ok)
      // Signal that the attempt is underway.
      if (version === '2004') {
        set('cmi.completion_status', 'incomplete')
      } else {
        // Only set incomplete if the LMS has not already recorded a final status.
        var status = callGet('cmi.core.lesson_status')
        if (!status || status === 'not attempted' || status === 'unknown' || status === '') {
          set('cmi.core.lesson_status', 'incomplete')
        }
      }
      this.commit()
      return true
    },

    isAvailable: function () {
      return !!api
    },

    getVersion: function () {
      return version
    },

    // raw/min/max are points; scaled (0..1) is derived for 2004.
    setScore: function (raw, min, max) {
      if (!api) return
      if (version === '2004') {
        var range = max - min
        var scaled = range > 0 ? (raw - min) / range : 0
        if (scaled < 0) scaled = 0
        if (scaled > 1) scaled = 1
        set('cmi.score.scaled', scaled)
        set('cmi.score.raw', raw)
        set('cmi.score.min', min)
        set('cmi.score.max', max)
      } else {
        set('cmi.core.score.raw', raw)
        set('cmi.core.score.min', min)
        set('cmi.core.score.max', max)
      }
    },

    // Marks the attempt's completion and (if assessed) passed/failed status.
    // `completed` lets the caller decide completion independently of the score,
    // so a "must pass" course can stay incomplete (and retryable) on a fail.
    setResult: function (completed, passed, assessed) {
      if (!api) return
      if (version === '2004') {
        set('cmi.completion_status', completed ? 'completed' : 'incomplete')
        if (assessed) {
          set('cmi.success_status', passed ? 'passed' : 'failed')
        }
      } else {
        // 1.2 conflates completion and success into a single lesson_status. For an
        // assessed course we report the outcome (passed/failed) — both terminal, so
        // the LMS counts the attempt; an unassessed course simply completes.
        if (assessed) {
          set('cmi.core.lesson_status', passed ? 'passed' : 'failed')
        } else {
          set('cmi.core.lesson_status', 'completed')
        }
      }
    },

    // Bookmark the learner's position for resume. 2004 uses cmi.location; 1.2 uses
    // cmi.core.lesson_location. The value is a short string (the lesson index).
    setLocation: function (value) {
      if (!api) return
      var el = version === '2004' ? 'cmi.location' : 'cmi.core.lesson_location'
      set(el, String(value == null ? '' : value))
      this.commit()
    },

    getLocation: function () {
      if (!api) return ''
      var el = version === '2004' ? 'cmi.location' : 'cmi.core.lesson_location'
      return callGet(el) || ''
    },

    /*
     * Records a single interaction.
     * opts: { id, type, learnerResponse, correctResponse, correct, result, latencyMs, description }
     * learnerResponse / correctResponse are arrays of identifiers. For an
     * ungraded item (e.g. a survey) pass result: 'neutral' and an empty
     * correctResponse — no correct pattern is written and the result is neutral.
     */
    recordInteraction: function (opts) {
      if (!api) return
      var n = interactionIndex++
      var base =
        version === '2004' ? 'cmi.interactions.' + n + '.' : 'cmi.interactions.' + n + '.'
      var now = new Date()
      var result = opts.result || (opts.correct ? 'correct' : 'incorrect')
      var hasCorrect = opts.correctResponse && opts.correctResponse.length

      // id and type first; some LMSs require id before other fields.
      set(base + 'id', opts.id)
      set(base + 'type', opts.type)

      if (version === '2004') {
        set(base + 'timestamp', iso8601DateTime(now))
        set(base + 'learner_response', joinChoices(opts.learnerResponse, '2004'))
        if (hasCorrect) set(base + 'correct_responses.0.pattern', joinChoices(opts.correctResponse, '2004'))
        set(base + 'result', result)
        set(base + 'latency', iso8601Duration(opts.latencyMs))
        if (opts.description) set(base + 'description', opts.description)
      } else {
        set(base + 'time', cmiTime(now))
        if (hasCorrect) set(base + 'correct_responses.0.pattern', joinChoices(opts.correctResponse, '1.2'))
        set(base + 'student_response', joinChoices(opts.learnerResponse, '1.2'))
        set(base + 'result', result)
        set(base + 'latency', cmiTimespan(opts.latencyMs))
      }
      this.commit()
    },

    commit: function () {
      if (!api) return
      var ok = callCommit()
      var err = lastError()
      if (err && err !== '0') log('Commit error', err)
      return ok
    },

    finish: function () {
      if (!api) return
      var elapsed = sessionStart ? new Date().getTime() - sessionStart.getTime() : 0
      if (version === '2004') {
        set('cmi.session_time', iso8601Duration(elapsed))
      } else {
        set('cmi.core.session_time', cmiTimespan(elapsed))
      }
      this.commit()
      var ok = callTerminate()
      log('Terminate ->', ok)
      api = null
      return ok
    },
  }

  // For 'choice' interactions, multiple identifiers are delimited differently
  // between versions: 2004 uses "[,]", 1.2 uses ",".
  function joinChoices(ids, ver) {
    if (!ids || !ids.length) return ''
    return ids.join(ver === '2004' ? '[,]' : ',')
  }

  global.SCORM = SCORM
})(window)
