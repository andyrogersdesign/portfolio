/*
 * AES report aggregation. Pure functions, no DOM.
 *
 * Written as a UMD classic script so it works two ways:
 *   - in the browser via <script src="aggregate.js"> (loads over file://, no CORS),
 *   - in Node via require(), so scripts/test-analyser.mjs can test it.
 *
 * It reads one respondent per file, in either format:
 *   - the survey's "download my responses" JSON, or
 *   - a Totara "Track details" CSV (Element,Value rows).
 * and aggregates band counts per question into the Below/Above-the-Bar report.
 */
;(function (root, factory) {
  var api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.AESReport = api
})(typeof self !== 'undefined' ? self : this, function () {
  // Bands, worst to best. Below the Bar = alarming + concerning.
  var BANDS = ['alarming', 'concerning', 'acceptable', 'superior']
  var BELOW = { alarming: true, concerning: true }

  function htmlUnescape(s) {
    return String(s)
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  }

  // Strip surrounding quotes from a CSV value (handles "" escaping) + unescape.
  function unquote(v) {
    v = String(v == null ? '' : v).trim()
    if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
      v = v.slice(1, -1).replace(/""/g, '"')
    }
    return htmlUnescape(v)
  }

  // Parse one respondent's file into { name, responses:[{reference,band,kind,prompt}] }.
  function parseResponseFile(text, name) {
    var trimmed = String(text || '').replace(/^\uFEFF/, '').trim()
    if (!trimmed) return { name: name, responses: [] }
    return trimmed.charAt(0) === '{' ? parseJson(trimmed, name) : parseCsv(trimmed, name)
  }

  function parseJson(text, name) {
    var out = { name: name, responses: [] }
    var data
    try {
      data = JSON.parse(text)
    } catch (e) {
      return out
    }
    var rs = (data && data.responses) || []
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i]
      if (r && BANDS.indexOf(r.band) >= 0) {
        out.responses.push({
          reference: r.reference || '',
          band: r.band,
          kind: r.kind || '',
          prompt: r.prompt || '',
          statement: r.statement || '',
          comment: r.comment || '',
        })
      }
    }
    return out
  }

  function parseCsv(text, name) {
    var out = { name: name, responses: [] }
    var lines = text.split(/\r\n|\r|\n/)
    var inter = {}
    for (var i = 0; i < lines.length; i++) {
      var comma = lines[i].indexOf(',')
      if (comma < 0) continue
      var key = lines[i].slice(0, comma).trim()
      var m = /^cmi\.interactions\.(\d+)\.(.+)$/.exec(key)
      if (!m) continue
      if (!inter[m[1]]) inter[m[1]] = {}
      inter[m[1]][m[2]] = unquote(lines[i].slice(comma + 1))
    }
    // First pass: collect the companion "__choice" and "__comment" fill-in
    // interactions, keyed by the base question id they belong to. The exact
    // statement text is carried alongside the band so the analyser doesn't
    // have to guess when a question has more than one statement per band.
    var choices = {}
    var comments = {}
    Object.keys(inter).forEach(function (idx) {
      var id = inter[idx]['id'] || ''
      var mc = /^(.+)__choice$/.exec(id)
      if (mc) choices[mc[1]] = inter[idx]['learner_response'] || ''
      var mk = /^(.+)__comment$/.exec(id)
      if (mk) comments[mk[1]] = inter[idx]['learner_response'] || ''
    })
    Object.keys(inter)
      .sort(function (a, b) {
        return Number(a) - Number(b)
      })
      .forEach(function (idx) {
        var it = inter[idx]
        if (BANDS.indexOf(it['learner_response']) >= 0) {
          out.responses.push({
            reference: it['id'] || '',
            band: it['learner_response'],
            kind: '',
            prompt: it['description'] || '',
            statement: choices[it['id']] || '',
            comment: comments[it['id']] || '',
          })
        }
      })
    return out
  }

  // Push a statement text into a per-band list, keeping unique entries with a
  // running count of how many respondents picked each one.
  function addStatement(list, text) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].text === text) {
        list[i].count++
        return
      }
    }
    list.push({ text: text, count: 1 })
  }

  // Aggregate an array of parsed files into the report. An optional survey map
  // lets the analyser render statement text even when the LMS export carries
  // only band codes, and also lets an audience preview a survey before any
  // responses have been collected.
  function aggregate(files, surveyMap) {
    var order = []
    var byRef = {}
    var respondents = 0
    for (var f = 0; f < files.length; f++) {
      var file = files[f]
      if (!file || !file.responses || !file.responses.length) continue
      respondents++
      for (var i = 0; i < file.responses.length; i++) {
        var r = file.responses[i]
        var ref = r.reference || '(unlabelled)'
        if (!byRef[ref]) {
          byRef[ref] = {
            reference: ref,
            kind: r.kind || '',
            prompt: r.prompt || '',
            total: 0,
            counts: { alarming: 0, concerning: 0, acceptable: 0, superior: 0 },
            // The unique statement wordings actually picked per band, across
            // all respondents. Arrays because a question may legitimately have
            // more than one statement per band; each entry keeps a count.
            statements: { alarming: [], concerning: [], acceptable: [], superior: [] },
            comments: [],
          }
          order.push(ref)
        }
        var q = byRef[ref]
        if (!q.prompt && r.prompt) q.prompt = r.prompt
        if (!q.kind && r.kind) q.kind = r.kind
        if (q.counts.hasOwnProperty(r.band)) {
          q.counts[r.band]++
          q.total++
          if (r.statement) addStatement(q.statements[r.band], r.statement)
          // Comments carry their context (band + statement picked) so the
          // accordion can show *who* said what, not just a floating quote.
          if (r.comment) q.comments.push({ comment: r.comment, band: r.band, statement: r.statement || '' })
        }
      }
    }

    // Index the survey map (if provided) by question reference for O(1) lookup.
    var mapByRef = {}
    if (surveyMap && surveyMap.questions) {
      for (var m = 0; m < surveyMap.questions.length; m++) {
        var mq = surveyMap.questions[m]
        if (mq && mq.reference) mapByRef[mq.reference] = mq
      }
      // If the map has a question with no responses yet, still include it so a
      // report author can preview which questions will appear.
      for (var mi = 0; mi < surveyMap.questions.length; mi++) {
        var qm = surveyMap.questions[mi]
        if (qm && qm.reference && !byRef[qm.reference]) {
          byRef[qm.reference] = {
            reference: qm.reference,
            kind: qm.kind || '',
            prompt: qm.prompt || '',
            total: 0,
            counts: { alarming: 0, concerning: 0, acceptable: 0, superior: 0 },
            statements: { alarming: [], concerning: [], acceptable: [], superior: [] },
            comments: [],
          }
          order.push(qm.reference)
        }
      }
    }

    var totAll = 0
    var belowAll = 0
    var questions = order.map(function (ref) {
      var q = byRef[ref]
      var pct = {}
      var below = 0
      BANDS.forEach(function (b) {
        pct[b] = q.total ? Math.round((q.counts[b] / q.total) * 100) : 0
        if (BELOW[b]) below += q.counts[b]
      })
      totAll += q.total
      belowAll += below

      // Enrich with the map: prefer the prompt/kind from the map when missing,
      // and fill in the reference set of statements per band, so the tooltip
      // can show all authored statements even when only the band is known.
      var mq2 = mapByRef[q.reference]
      if (mq2) {
        if (!q.prompt && mq2.prompt) q.prompt = mq2.prompt
        if (!q.kind && mq2.kind) q.kind = mq2.kind
      }
      var statementsByBand = {}
      BANDS.forEach(function (b) {
        var picked = q.statements[b] || []
        // Reference statements from the map, if any, tagged so the UI can tell
        // which were actually chosen vs which are just authored possibilities.
        var ref = mq2 && mq2.statementsByBand && mq2.statementsByBand[b] ? mq2.statementsByBand[b] : []
        var seen = {}
        var out = []
        for (var pi = 0; pi < picked.length; pi++) {
          out.push({ text: picked[pi].text, count: picked[pi].count, fromResponses: true })
          seen[picked[pi].text] = true
        }
        for (var ri = 0; ri < ref.length; ri++) {
          if (!seen[ref[ri]]) out.push({ text: ref[ri], count: 0, fromResponses: false })
        }
        statementsByBand[b] = out
      })

      return {
        reference: q.reference,
        kind: q.kind,
        prompt: q.prompt,
        total: q.total,
        counts: q.counts,
        pct: pct,
        belowPct: q.total ? Math.round((below / q.total) * 100) : 0,
        abovePct: q.total ? Math.round(((q.total - below) / q.total) * 100) : 0,
        statements: statementsByBand,
        comments: q.comments,
      }
    })

    return {
      respondents: respondents,
      questionCount: questions.length,
      totalResponses: totAll,
      overallBelowPct: totAll ? Math.round((belowAll / totAll) * 100) : 0,
      overallAbovePct: totAll ? Math.round(((totAll - belowAll) / totAll) * 100) : 0,
      questions: questions,
      bands: BANDS,
    }
  }

  // Decode a base64 payload (as emitted by the survey's Copy-response-link
  // button) back to a Course-response object. Silent on error.
  function decodeBase64Payload(b64) {
    try {
      // Prefer TextDecoder (modern browsers) with a fallback to the escape
      // pair (legacy contexts and jsdom, which doesn't expose TextDecoder).
      var bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
      var json
      if (typeof TextDecoder !== 'undefined') {
        var bytes = new Uint8Array(bin.length)
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        json = new TextDecoder().decode(bytes)
      } else {
        json = decodeURIComponent(escape(bin))
      }
      return JSON.parse(json)
    } catch (e) { return null }
  }

  // Extract the base64 response payload from a URL like
  //   https://andyrogers.design/tools/aes-report/#r=<base64>
  // Returns null if not a valid response URL.
  function extractResponseFromUrl(url) {
    var m = /[#&?]r=([A-Za-z0-9+/=_-]+)/.exec(String(url || ''))
    if (!m) return null
    return decodeBase64Payload(m[1])
  }

  // Parse a paste that may contain multiple responses in mixed forms — one per
  // line, or blank-line separated: raw JSON, bare base64 payloads, or full
  // response URLs. Returns an array of parsed files (same shape as parseResponseFile).
  function parsePaste(text) {
    var files = []
    var buf = String(text || '').trim()
    if (!buf) return files

    // First try the whole paste as a single JSON blob (multi-line pretty-printed).
    if (buf.charAt(0) === '{' || buf.charAt(0) === '[') {
      try {
        var whole = JSON.parse(buf)
        if (whole && whole.responses) return [parseJson(buf, 'pasted')]
        if (Array.isArray(whole)) {
          for (var i = 0; i < whole.length; i++) {
            files.push(parseJson(JSON.stringify(whole[i]), 'pasted-' + (i + 1)))
          }
          return files
        }
      } catch (e) { /* fall through to line-by-line */ }
    }

    // Otherwise split on blank lines (JSON blocks) or single newlines (URLs / base64).
    var chunks = buf.split(/\n\s*\n+/).map(function (c) { return c.trim() }).filter(Boolean)
    if (chunks.length === 1) chunks = chunks[0].split(/\r?\n/).map(function (c) { return c.trim() }).filter(Boolean)
    for (var c = 0; c < chunks.length; c++) {
      var chunk = chunks[c]
      // JSON object
      if (chunk.charAt(0) === '{') {
        files.push(parseJson(chunk, 'pasted-' + (c + 1)))
        continue
      }
      // Response URL
      var fromUrl = extractResponseFromUrl(chunk)
      if (fromUrl) {
        files.push(parseJson(JSON.stringify(fromUrl), 'pasted-' + (c + 1)))
        continue
      }
      // Bare base64 payload
      var decoded = decodeBase64Payload(chunk)
      if (decoded && decoded.responses) {
        files.push(parseJson(JSON.stringify(decoded), 'pasted-' + (c + 1)))
      }
    }
    return files
  }

  return {
    parseResponseFile: parseResponseFile,
    parsePaste: parsePaste,
    extractResponseFromUrl: extractResponseFromUrl,
    aggregate: aggregate,
    BANDS: BANDS,
  }
})
