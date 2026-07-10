/*
 * Course player.
 *
 * Renders the course embedded at window.__COURSE__ and wires knowledge-check
 * answers (and their latency) into the SCORM wrapper. Plain global script.
 *
 * Single-SCO architecture: the whole course is one trackable unit. Lessons are
 * navigated inside the player (contents + previous/next); scoring aggregates every
 * knowledge check across all lessons into one result.
 */
(function () {
  'use strict'

  // Optional brand mark, embedded as a data URI so the player stays a single
  // self-contained file. Empty by default; set to a data:image URI to show a
  // logo above the survey title.
  var BRAND_LOGO = '';

  var root = document.getElementById('app')
  if (!root) return

  // Course resolution: prefer a URL-hash config (the shareable-link flow),
  // fall back to an embedded window.__COURSE__ (SCORM package / direct demo).
  // If neither is present, render a friendly "no survey loaded" message.
  var course = decodeCourseFromUrl() || window.__COURSE__
  if (!course) {
    var noSurvey = document.createElement('div')
    noSurvey.className = 'course no-survey'
    noSurvey.innerHTML = '<h1>No survey loaded</h1>' +
      '<p>This link doesn\u2019t include a survey. Please check the URL you were sent, ' +
      'or return to <a href="/demos">the demos page</a> to see an example.</p>'
    root.appendChild(noSurvey)
    return
  }

  // Decode a Course from URL hash "#s=<base64-JSON>". Silent on any error, so
  // a bad hash simply falls through to the embedded fallback (or the empty
  // "no survey loaded" state above).
  function decodeCourseFromUrl() {
    try {
      var hash = String(window.location.hash || '').replace(/^#/, '')
      if (!hash) return null
      var params = new URLSearchParams(hash)
      var s = params.get('s')
      if (!s) return null
      var json = base64ToUtf8(s)
      var parsed = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && parsed.id && parsed.title) return parsed
      return null
    } catch (e) {
      return null
    }
  }

  // Base64 <-> UTF-8. Prefers modern TextEncoder/TextDecoder (available in
  // every current browser), falls back to escape/unescape (still supported
  // for legacy contexts and jsdom, which doesn't ship TextEncoder on window).
  function utf8ToBase64(str) {
    if (typeof TextEncoder !== 'undefined') {
      var bytes = new TextEncoder().encode(str)
      var bin = ''
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      return btoa(bin)
    }
    return btoa(unescape(encodeURIComponent(str)))
  }
  function base64ToUtf8(b64) {
    var bin = atob(b64)
    if (typeof TextDecoder !== 'undefined') {
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder().decode(bytes)
    }
    return decodeURIComponent(escape(bin))
  }

  // Per-question runtime state, keyed by block id. startTime is set when the
  // question's lesson is first shown, so latency reflects time-on-question.
  var questions = {}

  // Tracks interaction ids already used in this attempt so author references
  // stay unique (duplicates get a numeric suffix), keeping LMS reports clean.
  var usedInteractionIds = {}

  // Every AES survey response given this session, for the optional "download my
  // responses" export (the no-LMS path to collect data for the report analyser).
  var surveyResponses = []

  // Registry of rendered survey questions, so Finish can capture answers the
  // learner selected but didn't individually submit.
  var surveyQuestions = []

  // Reduce an author reference to a safe SCORM interaction id (CMIIdentifier:
  // letters, digits, dash, underscore; capped well under the 255-char limit).
  function sanitiseRef(value) {
    var out = String(value == null ? '' : value)
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
    return out.slice(0, 200)
  }

  // The interaction id for a question: its author reference if set, else the
  // block id. De-duplicated so two questions never share a reported id.
  function interactionIdFor(block) {
    var base = sanitiseRef(block.reference) || block.id
    var id = base
    var n = 2
    while (usedInteractionIds[id]) {
      id = base + '-' + n
      n++
    }
    usedInteractionIds[id] = true
    return id
  }

  // --- Rendering helpers -----------------------------------------------------

  function el(tag, className, attrs) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (attrs) {
      for (var k in attrs) {
        if (attrs.hasOwnProperty(k)) node.setAttribute(k, attrs[k])
      }
    }
    return node
  }

  // Trigger a browser download of a text file (used by the responses export).
  // Fallback clipboard write: temp <textarea> + document.execCommand. Not the
  // pretty path, but works in older browsers and inside some iframes where
  // navigator.clipboard.writeText is blocked.
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch (e) { return false }
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' })
    var url = URL.createObjectURL(blob)
    var a = el('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
  }

  // Visually-hidden polite live region for screen-reader announcements (used by
  // the results view now; extended to feedback/lesson changes in Phase 2).
  var liveRegion = null
  function announce(msg) {
    if (!liveRegion) {
      liveRegion = el('div', 'sr-only')
      liveRegion.setAttribute('aria-live', 'polite')
      liveRegion.setAttribute('role', 'status')
      document.body.appendChild(liveRegion)
    }
    liveRegion.textContent = ''
    // Defer so the same message announced twice still re-reads.
    setTimeout(function () { liveRegion.textContent = msg }, 60)
  }

  // Accessible image lightbox: an overlay dialog showing the enlarged image.
  // Traps focus on the close control, closes on Esc or a backdrop click, and
  // restores focus to whatever opened it. Only one is ever open at a time.
  var lightbox = null
  function openLightbox(src, alt) {
    closeLightbox()
    var opener = document.activeElement
    var overlay = el('div', 'lightbox', {
      role: 'dialog', 'aria-modal': 'true', 'aria-label': alt || 'Enlarged image',
    })
    var close = el('button', 'lightbox-close', { type: 'button', 'aria-label': 'Close image' })
    close.innerHTML = '&times;'
    var img = el('img', 'lightbox-img')
    img.src = src
    img.alt = alt || ''
    overlay.appendChild(close)
    overlay.appendChild(img)
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeLightbox() // backdrop only, not the image
    })
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeLightbox()
      } else if (e.key === 'Tab') {
        // Close is the only focusable control, so keep focus on it (a trap).
        e.preventDefault()
        close.focus()
      }
    })
    close.addEventListener('click', closeLightbox)
    lightbox = { overlay: overlay, opener: opener }
    document.body.appendChild(overlay)
    close.focus()
  }
  function closeLightbox() {
    if (!lightbox) return
    var lb = lightbox
    lightbox = null
    var overlay = lb.overlay
    var remove = function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }
    // Animate out, then remove. Reduced-motion (or no animation support) removes
    // at once; otherwise a fallback timer guards a missed animationend.
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      remove()
    } else {
      overlay.classList.add('closing')
      var fallback = setTimeout(remove, 280)
      overlay.addEventListener('animationend', function () {
        clearTimeout(fallback)
        remove()
      })
    }
    if (lb.opener && lb.opener.focus) lb.opener.focus()
  }

  // Shift in-block markdown headings down one level (h1→h2 … h5→h6) so the
  // lesson <h2> stays the section head and a text block's "##" nests beneath it
  // as an h3. Presentational only — the stored HTML is left untouched.
  function demoteHeadings(html) {
    return String(html == null ? '' : html).replace(/<(\/?)h([1-5])\b/gi, function (_m, slash, n) {
      return '<' + slash + 'h' + (parseInt(n, 10) + 1)
    })
  }

  function renderText(block) {
    var node = el('div', 'block block-text')
    node.innerHTML = demoteHeadings(block.html) // authored, trusted content
    return node
  }

  function renderImage(block) {
    var node = el('figure', 'block block-image')
    // Wrap the image in a button so it can be enlarged by click or keyboard
    // (restores Rise's zoom-on-click), opening the accessible lightbox.
    var trigger = el('button', 'image-zoom', {
      type: 'button',
      'aria-label': 'Enlarge image' + (block.alt ? ': ' + block.alt : ''),
    })
    var img = el('img')
    img.src = block.src
    img.alt = block.alt || ''
    trigger.appendChild(img)
    trigger.addEventListener('click', function () {
      openLightbox(block.src, block.alt || '')
    })
    node.appendChild(trigger)
    if (block.caption) {
      var cap = el('figcaption')
      cap.textContent = block.caption
      node.appendChild(cap)
    }
    return node
  }

  function renderVideo(block) {
    var node = el('figure', 'block block-video')
    var video = el('video', null, { controls: 'controls', playsinline: 'playsinline' })
    if (block.poster) video.setAttribute('poster', block.poster)
    video.src = block.src
    // Synchronised captions (WebVTT) when the author supplied a track file.
    if (block.captionsSrc) {
      var track = el('track', null, {
        kind: 'captions', src: block.captionsSrc, srclang: 'en', label: 'Captions',
      })
      track.setAttribute('default', 'default')
      video.appendChild(track)
    }
    node.appendChild(video)
    if (block.caption) {
      var cap = el('figcaption')
      cap.textContent = block.caption
      node.appendChild(cap)
    }
    // A collapsible transcript gives a full text alternative to the audio.
    if (block.transcript) {
      var details = el('details', 'video-transcript')
      var summary = el('summary')
      summary.textContent = 'Show transcript'
      var body = el('div', 'video-transcript-body')
      body.innerHTML = block.transcript // authored, trusted content
      details.appendChild(summary)
      details.appendChild(body)
      node.appendChild(details)
    }
    return node
  }

  function renderAccordion(block) {
    var node = el('div', 'block block-accordion')
    var baseId = 'acc-' + (block.id || Math.random().toString(36).slice(2))
    block.items.forEach(function (item, i) {
      var headId = baseId + '-head-' + i
      var panelId = baseId + '-panel-' + i
      var wrap = el('div', 'accordion-item')
      var head = el('button', 'accordion-head', {
        type: 'button', id: headId, 'aria-controls': panelId, 'aria-expanded': 'false',
      })
      head.textContent = item.heading
      var body = el('div', 'accordion-body', {
        id: panelId, role: 'region', 'aria-labelledby': headId,
      })
      body.innerHTML = item.html
      body.style.display = 'none'
      head.addEventListener('click', function () {
        var open = body.style.display !== 'none'
        body.style.display = open ? 'none' : 'block'
        head.classList.toggle('open', !open)
        head.setAttribute('aria-expanded', open ? 'false' : 'true')
      })
      wrap.appendChild(head)
      wrap.appendChild(body)
      node.appendChild(wrap)
    })
    return node
  }

  function renderTabs(block) {
    var node = el('div', 'block block-tabs')
    var bar = el('div', 'tab-bar', { role: 'tablist' })
    var panels = el('div', 'tab-panels')
    var baseId = 'tabs-' + (block.id || Math.random().toString(36).slice(2))
    var tabBtns = []
    var tabPanels = []

    // Select tab i: update aria-selected, roving tabindex, the active class, and
    // panel visibility. focusTab moves keyboard focus (arrow/Home/End handler).
    function select(i, focusTab) {
      for (var j = 0; j < tabBtns.length; j++) {
        var on = j === i
        tabBtns[j].setAttribute('aria-selected', on ? 'true' : 'false')
        tabBtns[j].setAttribute('tabindex', on ? '0' : '-1')
        tabBtns[j].classList.toggle('active', on)
        tabPanels[j].style.display = on ? 'block' : 'none'
      }
      if (focusTab && tabBtns[i]) tabBtns[i].focus()
    }

    block.items.forEach(function (item, i) {
      var tabId = baseId + '-tab-' + i
      var panelId = baseId + '-panel-' + i
      var btn = el('button', 'tab-btn', {
        type: 'button', role: 'tab', id: tabId,
        'aria-controls': panelId, 'aria-selected': 'false', tabindex: '-1',
      })
      btn.textContent = item.label
      var panel = el('div', 'tab-panel', {
        role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, tabindex: '0',
      })
      panel.innerHTML = item.html
      panel.style.display = 'none'
      btn.addEventListener('click', function () { select(i, false) })
      btn.addEventListener('keydown', function (e) {
        var last = tabBtns.length - 1
        var to = -1
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = i >= last ? 0 : i + 1
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = i <= 0 ? last : i - 1
        else if (e.key === 'Home') to = 0
        else if (e.key === 'End') to = last
        if (to >= 0) {
          e.preventDefault()
          select(to, true)
        }
      })
      bar.appendChild(btn)
      panels.appendChild(panel)
      tabBtns.push(btn)
      tabPanels.push(panel)
    })
    node.appendChild(bar)
    node.appendChild(panels)
    if (tabBtns.length) select(0, false)
    return node
  }

  // Shared: lock the question, show feedback, and remember the result.
  function markAnswered(block, isCorrect, inputs, submit, feedback) {
    questions[block.id].answered = true
    questions[block.id].correct = isCorrect
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = true
    submit.disabled = true
    feedback.style.display = 'block'
    feedback.className = 'kc-feedback ' + (isCorrect ? 'correct' : 'incorrect')
    var msg = isCorrect
      ? (block.feedbackCorrect || 'Correct.')
      : (block.feedbackIncorrect || 'Not quite.')
    feedback.innerHTML = inlineMd(msg)
    // Announce the outcome for screen-reader users (the feedback appears
    // visually but isn't focused, so it would otherwise go unread).
    announce((isCorrect ? 'Correct. ' : 'Not quite. ') + plainText(msg))
  }

  function latencyFor(block) {
    var started = questions[block.id].startTime
    return started == null ? 0 : Date.now() - started
  }

  // Normalise a True/False choice to the SCORM literal 'true' / 'false'.
  function tfValue(choice) {
    if (!choice) return ''
    var t = String(choice.html || '').toLowerCase()
    if (t === 'true' || t === 'false') return t
    return choice.correct ? 'true' : 'false'
  }

  // Short, SCORM-safe response identifier for a choice by position: a, b, c, ...
  // LMS SCORM 2004 runtimes (Totara/Moodle) can reject long or hyphenated choice
  // identifiers, so we report stable positional tokens rather than internal ids.
  function choiceToken(index) {
    return index < 26 ? String.fromCharCode(97 + index) : String(index + 1)
  }

  // Fisher-Yates shuffle (returns a new array; the original choice order is left
  // intact in the model). Called per render, so each launch reshuffles.
  function shuffleArray(arr) {
    var a = arr.slice()
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1))
      var tmp = a[i]
      a[i] = a[j]
      a[j] = tmp
    }
    return a
  }

  // Escape HTML so author text can be placed safely with innerHTML.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  // Render a safe subset of inline markdown (bold, italic, code, http links) for
  // question prompts and feedback. Escapes first, so no raw HTML can slip through.
  function inlineMd(text) {
    var s = escapeHtml(text)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>')
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return s
  }

  // Strip inline markdown markers to plain text (for the SCORM interaction
  // description, which should read cleanly in LMS reports).
  function plainText(text) {
    return String(text == null ? '' : text)
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
  }

  // A clear, colour-coded tag telling the learner whether a question counts
  // towards their score or is practice. Sits at the top of the question card.
  function scoreTagRow(graded) {
    var row = el('div', 'kc-tag-row')
    var tag = el('span', 'kc-tag ' + (graded ? 'scored' : 'practice'))
    tag.textContent = graded ? 'Counts towards your score' : 'Practice \u2014 not scored'
    row.appendChild(tag)
    return row
  }

  function renderKnowledgeCheck(block) {
    var kind = block.kind || 'multiple'
    return kind === 'fillIn' ? renderFillIn(block) : renderChoiceQuestion(block, kind)
  }

  // Choice-based questions: multiple choice / multiple response / true-false.
  function renderChoiceQuestion(block, kind) {
    var graded = block.graded !== false
    var node = el('div', 'block block-kc ' + (graded ? 'kc-scored' : 'kc-practice'))
    node.appendChild(scoreTagRow(graded))
    // The options form a labelled group: a fieldset with the prompt as its
    // legend, so screen readers announce the question with each option.
    var fieldset = el('fieldset', 'kc-fieldset')
    var prompt = el('legend', 'kc-prompt')
    prompt.innerHTML = inlineMd(block.prompt)
    fieldset.appendChild(prompt)
    node.appendChild(fieldset)

    var isTrueFalse = kind === 'trueFalse'
    var inputType = !isTrueFalse && block.multiple ? 'checkbox' : 'radio'
    if (block.multiple && !isTrueFalse) {
      var hint = el('p', 'kc-hint')
      hint.textContent = 'Select all that apply.'
      fieldset.appendChild(hint)
    }
    var choiceEls = []
    // Shuffle answer order on each view (multiple-choice only), so a retry after a
    // fail never shows the same positions — the correct answer isn't always first.
    // True/False keeps its natural order. Tokens are assigned in display order, so
    // the SCORM response/pattern reflect what the learner actually saw.
    var displayChoices =
      !isTrueFalse && block.shuffle !== false ? shuffleArray(block.choices) : block.choices

    displayChoices.forEach(function (choice, index) {
      var label = el('label', 'kc-choice')
      var input = el('input')
      input.type = inputType
      input.name = 'q_' + block.id
      input.value = choice.id
      var span = el('span')
      span.innerHTML = choice.html
      label.appendChild(input)
      label.appendChild(span)
      fieldset.appendChild(label)
      choiceEls.push({ input: input, choice: choice, token: choiceToken(index) })
    })

    var submit = el('button', 'kc-submit', { type: 'button' })
    submit.textContent = 'Check answer'
    var feedback = el('div', 'kc-feedback')
    feedback.style.display = 'none'
    node.appendChild(submit)
    node.appendChild(feedback)

    // Latency clock is started lazily when the lesson is first shown.
    questions[block.id] = { answered: false, correct: false, startTime: null, interactionId: interactionIdFor(block), graded: block.graded !== false, weight: block.weight, prompt: block.prompt, feedbackIncorrect: block.feedbackIncorrect }

    submit.addEventListener('click', function () {
      if (questions[block.id].answered) return

      var selected = []
      var selectedTokens = []
      choiceEls.forEach(function (c) {
        if (c.input.checked) {
          selected.push(c.choice.id)
          selectedTokens.push(c.token)
        }
      })
      if (!selected.length) {
        feedback.style.display = 'block'
        feedback.className = 'kc-feedback warn'
        feedback.textContent = 'Please choose an answer first.'
        return
      }

      var correctIds = block.choices
        .filter(function (c) { return c.correct })
        .map(function (c) { return c.id })
      var correctTokens = choiceEls
        .filter(function (c) { return c.choice.correct })
        .map(function (c) { return c.token })

      var isCorrect = sameSet(selected, correctIds)
      var inputs = choiceEls.map(function (c) { return c.input })
      markAnswered(block, isCorrect, inputs, submit, feedback)

      if (isTrueFalse) {
        var selChoice = block.choices.filter(function (c) { return selected.indexOf(c.id) >= 0 })[0]
        var corChoice = block.choices.filter(function (c) { return c.correct })[0]
        window.SCORM.recordInteraction({
          id: questions[block.id].interactionId,
          type: 'true-false',
          learnerResponse: [tfValue(selChoice)],
          correctResponse: [tfValue(corChoice)],
          correct: isCorrect,
          latencyMs: latencyFor(block),
          description: plainText(block.prompt),
        })
      } else {
        window.SCORM.recordInteraction({
          id: questions[block.id].interactionId,
          type: 'choice',
          learnerResponse: selectedTokens,
          correctResponse: correctTokens,
          correct: isCorrect,
          latencyMs: latencyFor(block),
          description: plainText(block.prompt),
        })
      }
    })

    return node
  }

  // Short-answer / fill-in: free text matched against the accepted answers.
  function renderFillIn(block) {
    var graded = block.graded !== false
    var node = el('div', 'block block-kc ' + (graded ? 'kc-scored' : 'kc-practice'))
    node.appendChild(scoreTagRow(graded))
    var prompt = el('p', 'kc-prompt')
    prompt.innerHTML = inlineMd(block.prompt)
    node.appendChild(prompt)

    var input = el('input', 'kc-fill-input')
    input.type = 'text'
    input.setAttribute('aria-label', 'Your answer')
    input.setAttribute('autocomplete', 'off')
    node.appendChild(input)

    var submit = el('button', 'kc-submit', { type: 'button' })
    submit.textContent = 'Check answer'
    var feedback = el('div', 'kc-feedback')
    feedback.style.display = 'none'
    node.appendChild(submit)
    node.appendChild(feedback)

    questions[block.id] = { answered: false, correct: false, startTime: null, interactionId: interactionIdFor(block), graded: block.graded !== false, weight: block.weight, prompt: block.prompt, feedbackIncorrect: block.feedbackIncorrect }

    function normalise(s, caseSensitive) {
      var trimmed = String(s == null ? '' : s).replace(/^\s+|\s+$/g, '')
      return caseSensitive ? trimmed : trimmed.toLowerCase()
    }

    function check() {
      if (questions[block.id].answered) return
      var typed = String(input.value || '').replace(/^\s+|\s+$/g, '')
      if (!typed) {
        feedback.style.display = 'block'
        feedback.className = 'kc-feedback warn'
        feedback.textContent = 'Please type an answer first.'
        return
      }
      var accepted = block.acceptedAnswers || []
      var typedN = normalise(typed, block.caseSensitive)
      var isCorrect = false
      for (var i = 0; i < accepted.length; i++) {
        if (normalise(accepted[i], block.caseSensitive) === typedN) {
          isCorrect = true
          break
        }
      }
      markAnswered(block, isCorrect, [input], submit, feedback)
      window.SCORM.recordInteraction({
        id: questions[block.id].interactionId,
        type: 'fill-in',
        learnerResponse: [typed],
        correctResponse: [accepted[0] || ''],
        correct: isCorrect,
        latencyMs: latencyFor(block),
        description: plainText(block.prompt),
      })
    }

    submit.addEventListener('click', check)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        check()
      }
    })

    return node
  }

  // --- New engaging blocks (ungraded) ---------------------------------------

  function renderCallout(block) {
    var node = el('div', 'block block-callout callout-' + (block.variant || 'info'))
    node.innerHTML = block.html // authored, trusted content
    return node
  }

  function renderFlashcards(block) {
    var node = el('div', 'block block-flashcards')
    ;(block.cards || []).forEach(function (card) {
      // A true 3D flip: the button is the perspective container, an inner
      // wrapper rotates, and the two faces sit back-to-back (CSS handles it).
      var c = el('button', 'flashcard', { type: 'button', 'aria-pressed': 'false' })
      var inner = el('div', 'flashcard-inner')
      var front = el('div', 'flashcard-face flashcard-front')
      front.innerHTML = inlineMd(card.front)
      var back = el('div', 'flashcard-face flashcard-back')
      back.innerHTML = card.back // authored, trusted content
      inner.appendChild(front)
      inner.appendChild(back)
      c.appendChild(inner)
      c.addEventListener('click', function () {
        var flipped = c.classList.toggle('flipped')
        c.setAttribute('aria-pressed', flipped ? 'true' : 'false')
      })
      node.appendChild(c)
    })
    return node
  }

  function renderSorting(block) {
    var node = el('div', 'block block-sorting')
    if (block.prompt) {
      var p = el('p', 'sorting-prompt')
      p.innerHTML = inlineMd(block.prompt)
      node.appendChild(p)
    }
    var cats = block.categories || []
    var rows = []
    ;(block.items || []).forEach(function (item) {
      var row = el('div', 'sorting-row')
      var label = el('span', 'sorting-item')
      label.innerHTML = inlineMd(item.text)
      var sel = el('select', 'sorting-select')
      var blank = el('option')
      blank.value = ''
      blank.textContent = 'Choose…'
      sel.appendChild(blank)
      cats.forEach(function (cat) {
        var o = el('option')
        o.value = cat
        o.textContent = cat
        sel.appendChild(o)
      })
      var mark = el('span', 'sorting-mark')
      row.appendChild(label)
      row.appendChild(sel)
      row.appendChild(mark)
      node.appendChild(row)
      rows.push({ item: item, sel: sel, mark: mark })
    })
    var submit = el('button', 'kc-submit', { type: 'button' })
    submit.textContent = 'Check'
    var feedback = el('div', 'kc-feedback')
    feedback.style.display = 'none'
    submit.addEventListener('click', function () {
      var allRight = true
      var answered = 0
      rows.forEach(function (r) {
        if (!r.sel.value) {
          allRight = false
          return
        }
        answered++
        var ok = r.sel.value === r.item.category
        r.mark.textContent = ok ? '\u2713' : '\u2717'
        r.mark.className = 'sorting-mark ' + (ok ? 'right' : 'wrong')
        if (!ok) allRight = false
      })
      feedback.style.display = 'block'
      if (answered < rows.length) {
        feedback.className = 'kc-feedback warn'
        feedback.textContent = 'Sort every item first.'
      } else {
        feedback.className = 'kc-feedback ' + (allRight ? 'correct' : 'incorrect')
        feedback.textContent = allRight
          ? 'All sorted correctly.'
          : 'Some are in the wrong category — adjust and check again.'
      }
    })
    node.appendChild(submit)
    node.appendChild(feedback)
    return node
  }

  function renderScenario(block) {
    var node = el('div', 'block block-scenario')
    if (block.setup) {
      var setup = el('p', 'scenario-setup')
      setup.innerHTML = inlineMd(block.setup)
      node.appendChild(setup)
    }
    var choicesWrap = el('div', 'scenario-choices')
    var outcome = el('div', 'scenario-outcome')
    outcome.style.display = 'none'
    ;(block.choices || []).forEach(function (choice) {
      var btn = el('button', 'scenario-choice', { type: 'button' })
      btn.innerHTML = inlineMd(choice.text)
      btn.addEventListener('click', function () {
        var btns = choicesWrap.querySelectorAll('.scenario-choice')
        for (var i = 0; i < btns.length; i++) btns[i].classList.remove('chosen')
        btn.classList.add('chosen')
        outcome.innerHTML = inlineMd(choice.outcome || '')
        outcome.style.display = 'block'
        // Replay the gentle reveal each time a choice is picked.
        outcome.classList.remove('reveal')
        void outcome.offsetWidth
        outcome.classList.add('reveal')
      })
      choicesWrap.appendChild(btn)
    })
    node.appendChild(choicesWrap)
    node.appendChild(outcome)
    return node
  }

  // Record a single AES survey answer once (deduped via entry.recorded): a
  // neutral SCORM interaction plus a line for the downloadable responses file.
  function recordSurvey(entry, chosen) {
    if (entry.recorded || !chosen) return
    entry.recorded = true
    var prompt = plainText(entry.block.prompt)
    var statement = plainText(chosen.text)
    var comment = entry.getComment ? entry.getComment() : ''
    var latency = Date.now() - entry.startTime
    // The primary interaction records the band, so LMS reports and roll-ups
    // read cleanly (e.g. "alarming") without needing the map to make sense.
    window.SCORM.recordInteraction({
      id: entry.interactionId,
      type: 'choice',
      learnerResponse: [chosen.category],
      correctResponse: [],
      result: 'neutral',
      latencyMs: latency,
      description: prompt,
    })
    // Companion fill-in carrying the exact statement text the respondent picked,
    // so a CSV export from an LMS can be disambiguated when the question has
    // more than one statement per band. Parallel pattern to __comment. The
    // analyser pairs "<id>__choice" back to "<id>" to fill in the tooltip.
    window.SCORM.recordInteraction({
      id: entry.interactionId + '__choice',
      type: 'fill-in',
      learnerResponse: [statement],
      correctResponse: [],
      result: 'neutral',
      latencyMs: latency,
      description: 'Statement: ' + prompt,
    })
    // A non-empty comment is also recorded as a neutral fill-in, so it carries
    // into an LMS export as well as the downloadable responses file.
    if (comment) {
      window.SCORM.recordInteraction({
        id: entry.interactionId + '__comment',
        type: 'fill-in',
        learnerResponse: [comment],
        correctResponse: [],
        result: 'neutral',
        latencyMs: latency,
        description: 'Comment: ' + prompt,
      })
    }
    surveyResponses.push({
      reference: entry.interactionId,
      kind: entry.block.surveyKind,
      band: chosen.category,
      prompt: prompt,
      statement: statement,
      comment: comment,
    })
  }

  // On Finish, capture any answers the learner selected but didn't submit
  // individually (i.e. they filled the survey and pressed Finish).
  function captureUnsubmittedSurveys() {
    for (var i = 0; i < surveyQuestions.length; i++) {
      var entry = surveyQuestions[i]
      if (!entry.recorded) recordSurvey(entry, entry.getChosen())
    }
  }

  function renderSurvey(block) {
    var node = el('div', 'block block-survey')
    var fieldset = el('fieldset', 'kc-fieldset')
    var prompt = el('legend', 'kc-prompt')
    prompt.innerHTML = inlineMd(block.prompt)
    fieldset.appendChild(prompt)
    node.appendChild(fieldset)
    var name = 'survey_' + block.id
    var optEls = []
    ;(block.options || []).forEach(function (opt) {
      var label = el('label', 'survey-option')
      var input = el('input')
      input.type = 'radio'
      input.name = name
      input.value = opt.id
      var span = el('span')
      span.innerHTML = inlineMd(opt.text)
      label.appendChild(input)
      label.appendChild(span)
      fieldset.appendChild(label)
      optEls.push({ input: input, option: opt })
    })
    function getChosen() {
      for (var i = 0; i < optEls.length; i++) {
        if (optEls[i].input.checked) return optEls[i].option
      }
      return null
    }

    // An optional free-text comment, shown unless the author turns it off. It is
    // captured alongside the chosen statement when the survey is submitted.
    var commentInput = null
    if (block.comment !== false) {
      var commentWrap = el('div', 'survey-comment')
      var commentId = 'comment_' + block.id
      var commentLabel = el('label', 'survey-comment-label', { for: commentId })
      commentLabel.textContent = 'Add a comment (optional)'
      commentInput = el('textarea', 'survey-comment-input', { id: commentId, rows: '2' })
      commentWrap.appendChild(commentLabel)
      commentWrap.appendChild(commentInput)
      node.appendChild(commentWrap)
    }
    function getComment() {
      return commentInput ? String(commentInput.value || '').replace(/^\s+|\s+$/g, '') : ''
    }

    // No per-question submit: the respondent simply picks an answer. Every answer
    // is captured together when they press Finish (see captureUnsubmittedSurveys).
    surveyQuestions.push({
      block: block,
      interactionId: interactionIdFor(block),
      startTime: Date.now(),
      recorded: false,
      getChosen: getChosen,
      getComment: getComment,
    })
    return node
  }

  var renderers = {
    text: renderText,
    image: renderImage,
    video: renderVideo,
    accordion: renderAccordion,
    tabs: renderTabs,
    knowledgeCheck: renderKnowledgeCheck,
    callout: renderCallout,
    flashcards: renderFlashcards,
    sorting: renderSorting,
    scenario: renderScenario,
    survey: renderSurvey,
  }

  function renderBlock(block) {
    var fn = renderers[block.type]
    return fn ? fn(block) : null
  }

  // --- Layout + lesson navigation -------------------------------------------

  function render() {
    var lessons = course.lessons || []
    var total = lessons.length
    var multi = total > 1

    var active = 0
    var shown = {}
    var firstShow = true
    var visited = {}
    var sections = []
    var navButtons = []
    var lessonKcIds = [] // block ids of knowledge checks, per lesson

    var container = el('div', 'course')

    var header = el('header', 'course-header')
    if (BRAND_LOGO && BRAND_LOGO.indexOf('data:image') === 0) {
      var brand = el('div', 'course-brand')
      var logo = el('img', 'course-logo')
      logo.src = BRAND_LOGO
      logo.alt = ''
      brand.appendChild(logo)
      header.appendChild(brand)
    }
    var h1 = el('h1')
    h1.textContent = course.title
    header.appendChild(h1)
    if (course.description) {
      var intro = el('p', 'course-intro')
      intro.textContent = course.description
      header.appendChild(intro)
    }
    container.appendChild(header)

    // Contents navigation (only when there's more than one lesson).
    var nav = null
    if (multi) {
      nav = el('nav', 'course-contents')
      nav.setAttribute('aria-label', 'Lesson contents')
      lessons.forEach(function (lesson, i) {
        var b = el('button', 'contents-item', { type: 'button' })
        b.textContent = i + 1 + '. ' + lesson.title
        b.addEventListener('click', function () {
          showLesson(i)
        })
        nav.appendChild(b)
        navButtons.push(b)
      })
      container.appendChild(nav)
    }

    // All lessons rendered up front; only the active one is shown.
    var lessonsWrap = el('div', 'lessons')
    lessons.forEach(function (lesson, i) {
      var section = el('section', 'lesson')
      section.setAttribute('data-index', String(i))
      var h2 = el('h2')
      h2.textContent = lesson.title
      section.appendChild(h2)
      var kcIds = []
      ;(lesson.blocks || []).forEach(function (block) {
        var bnode = renderBlock(block)
        if (bnode) section.appendChild(bnode)
        if (block.type === 'knowledgeCheck') kcIds.push(block.id)
      })
      lessonsWrap.appendChild(section)
      sections.push(section)
      lessonKcIds.push(kcIds)
    })
    container.appendChild(lessonsWrap)

    // Footer: progress + navigation + finish.
    var footer = el('footer', 'course-footer')
    var progress = el('div', 'lesson-progress')
    // A slim progress bar (decorative; the "Lesson N of M" text carries the
    // same meaning for screen readers, so the bar is aria-hidden).
    var progressTrack = el('div', 'progress-track', { 'aria-hidden': 'true' })
    var progressFill = el('div', 'progress-fill')
    progressTrack.appendChild(progressFill)
    if (!multi) progressTrack.style.display = 'none'
    var controls = el('div', 'nav-controls')
    var prevBtn = el('button', 'nav-btn prev', { type: 'button' })
    prevBtn.textContent = '\u2190 Previous'
    var nextBtn = el('button', 'nav-btn next', { type: 'button' })
    nextBtn.textContent = 'Next \u2192'
    var hasGraded = (course.lessons || []).some(function (l) {
      return (l.blocks || []).some(function (b) {
        return b.type === 'knowledgeCheck' && b.graded !== false
      })
    })
    var finishBtn = el('button', 'finish-btn', { type: 'button' })
    finishBtn.textContent = hasGraded ? 'Finish & send results' : 'Submit survey'

    prevBtn.addEventListener('click', function () {
      showLesson(active - 1)
    })
    nextBtn.addEventListener('click', function () {
      showLesson(active + 1)
    })
    finishBtn.addEventListener('click', function () {
      captureUnsubmittedSurveys()
      var res = computeResult()
      commitResult(res)
      finishBtn.disabled = true
      showResults(res)
    })

    controls.appendChild(prevBtn)
    controls.appendChild(nextBtn)
    controls.appendChild(finishBtn)
    footer.appendChild(progress)
    footer.appendChild(progressTrack)
    footer.appendChild(controls)
    container.appendChild(footer)

    root.appendChild(container)

    function startLatencyFor(i) {
      if (shown[i]) return
      shown[i] = true
      lessonKcIds[i].forEach(function (id) {
        if (questions[id] && !questions[id].answered && questions[id].startTime == null) {
          questions[id].startTime = Date.now()
        }
      })
    }

    function showLesson(i) {
      if (i < 0 || i >= total) return
      active = i
      for (var s = 0; s < sections.length; s++) {
        sections[s].style.display = s === i ? '' : 'none'
      }
      // Replay the gentle entrance animation on the newly shown lesson.
      var activeSection = sections[i]
      if (activeSection) {
        activeSection.classList.remove('lesson-enter')
        void activeSection.offsetWidth
        activeSection.classList.add('lesson-enter')
      }
      visited[i] = true
      for (var n = 0; n < navButtons.length; n++) {
        navButtons[n].classList.toggle('active', n === i)
        navButtons[n].classList.toggle('visited', !!visited[n])
      }
      progress.textContent = multi ? 'Lesson ' + (i + 1) + ' of ' + total : ''
      if (multi) {
        var seen = 0
        for (var key in visited) {
          if (visited.hasOwnProperty(key)) seen++
        }
        progressFill.style.width = Math.round((seen / total) * 100) + '%'
      }
      prevBtn.style.display = multi && i > 0 ? '' : 'none'
      nextBtn.style.display = multi && i < total - 1 ? '' : 'none'
      finishBtn.style.display = i === total - 1 ? '' : 'none'
      window.SCORM.setLocation(String(i))
      startLatencyFor(i)
      // Announce lesson changes to screen-reader users (but not the initial
      // load — only genuine navigation). Multi-lesson courses only.
      if (multi && !firstShow) {
        announce('Lesson ' + (i + 1) + ' of ' + total + ': ' + lessons[i].title)
      }
      firstShow = false
      if (window.scrollTo) window.scrollTo(0, 0)
    }

    // The results view takes over the content area on Finish (R2): bold, clear,
    // minimalist. Status, hero score, the revisit list (on a fail), and a single
    // line of guidance — close the activity and reopen to try again.
    function showResults(res) {
      if (nav) nav.style.display = 'none'
      lessonsWrap.style.display = 'none'
      controls.style.display = 'none'
      progress.style.display = 'none'

      var panel = el('div', 'results ' + (!res.assessed ? 'results-done' : res.passed ? 'results-pass' : 'results-fail'))
      panel.setAttribute('role', 'region')
      panel.setAttribute('aria-label', 'Your results')

      var status = el('h2', 'results-status', { tabindex: '-1' })
      status.textContent = !res.assessed ? 'Complete' : res.passed ? 'Passed' : 'Almost there'
      panel.appendChild(status)

      var announcement = status.textContent + '.'

      if (res.assessed) {
        var score = el('div', 'results-score')
        score.textContent = res.correct + ' / ' + res.total
        panel.appendChild(score)
        var sub = el('p', 'results-sub')
        sub.textContent = 'Pass mark ' + Math.round(res.passMark * 100) + '% · you scored ' + res.percent + '%'
        panel.appendChild(sub)
        announcement += ' You scored ' + res.correct + ' out of ' + res.total + '.'
      }

      if (res.assessed && !res.passed && res.missed.length) {
        var revHead = el('h3', 'results-revisit-head')
        revHead.textContent = 'Revisit ' + (res.missed.length === 1 ? 'this' : 'these ' + res.missed.length)
        panel.appendChild(revHead)
        var list = el('div', 'results-revisit')
        res.missed.forEach(function (m) {
          var item = el('div', 'results-item')
          var q = el('p', 'results-item-q')
          q.innerHTML = inlineMd(m.prompt || '')
          item.appendChild(q)
          if (m.feedback) {
            var fb = el('p', 'results-item-fb')
            fb.innerHTML = inlineMd(m.feedback)
            item.appendChild(fb)
          }
          list.appendChild(item)
        })
        panel.appendChild(list)
        announcement += ' Revisit ' + res.missed.length + ', then reopen the activity to try again.'
      }

      // Response summary: shown on screen so the respondent can review what
      // they submitted, and used as the print-friendly PDF content.
      if (surveyResponses.length) {
        var summary = el('section', 'results-summary')
        summary.setAttribute('aria-label', 'Your responses')
        var summaryHead = el('h3', 'results-summary-head')
        summaryHead.textContent = 'Your responses'
        summary.appendChild(summaryHead)
        var completed = el('p', 'results-summary-meta')
        completed.textContent = 'Completed ' + new Date().toLocaleString('en-GB', {
          year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })
        summary.appendChild(completed)
        var list = el('ol', 'results-summary-list')
        var bandLabels = { alarming: 'Alarming', concerning: 'Concerning', acceptable: 'Acceptable', superior: 'Superior' }
        surveyResponses.forEach(function (r) {
          var item = el('li', 'results-summary-item')
          item.setAttribute('data-band', r.band)
          var q = el('p', 'results-summary-q')
          q.textContent = r.prompt || r.reference
          item.appendChild(q)
          var choice = el('p', 'results-summary-choice')
          var bandTag = el('span', 'results-summary-band')
          bandTag.textContent = bandLabels[r.band] || r.band
          choice.appendChild(bandTag)
          if (r.statement) {
            var stmt = el('em', 'results-summary-statement')
            stmt.textContent = '\u201c' + r.statement + '\u201d'
            choice.appendChild(document.createTextNode(' '))
            choice.appendChild(stmt)
          }
          item.appendChild(choice)
          if (r.comment) {
            var c = el('p', 'results-summary-comment')
            var cl = el('span', 'results-summary-comment-label')
            cl.textContent = 'Your comment: '
            c.appendChild(cl)
            c.appendChild(document.createTextNode(r.comment))
            item.appendChild(c)
          }
          list.appendChild(item)
        })
        summary.appendChild(list)
        panel.appendChild(summary)
      }

      // Actions when the respondent has completed a survey and there is no LMS
      // capturing the data. Primary: Save as PDF (browser print dialog).
      // Secondary: send responses to the author (mailto), copy a response link
      // for pasting into the analyser, or download the raw JSON as a fallback.
      if (surveyResponses.length) {
        var payload = {
          survey: course.id,
          title: course.title,
          completedAt: new Date().toISOString(),
          responses: surveyResponses,
        }
        var payloadJson = JSON.stringify(payload, null, 2)

        // Base64-encode the payload for the response link (URL-safe). Uses
        // TextEncoder under the hood to survive UTF-8 characters correctly.
        var b64 = ''
        try { b64 = utf8ToBase64(JSON.stringify(payload)) } catch (e) { b64 = '' }
        var responseUrl = (function () {
          if (!b64) return ''
          // Point at the analyser so a click opens the report with this one
          // response loaded. Falls back to a relative path in dev.
          var analyserBase = 'https://andyrogers.design/demos/aes-report/'
          return analyserBase + '#r=' + b64
        })()

        var actions = el('div', 'results-actions')

        var pdf = el('button', 'kc-submit results-pdf', { type: 'button' })
        pdf.textContent = 'Save results as PDF'
        pdf.addEventListener('click', function () { window.print() })
        actions.appendChild(pdf)

        // Send by email: opens the respondent's mail client with a pre-filled
        // message. Only shown when the author has set an email on the course.
        if (course.authorEmail) {
          var send = el('button', 'kc-submit results-send', { type: 'button' })
          send.textContent = 'Send responses to ' + (course.authorName || 'the survey author')
          send.addEventListener('click', function () {
            var subject = 'AES response: ' + course.title
            var body = 'My responses to \u201c' + course.title + '\u201d:\n\n' + payloadJson +
              '\n\n(This message was generated by AESurvey Studio.)'
            window.location.href = 'mailto:' + encodeURIComponent(course.authorEmail) +
              '?subject=' + encodeURIComponent(subject) +
              '&body=' + encodeURIComponent(body)
          })
          actions.appendChild(send)
        }

        // Copy response link: puts a URL on the clipboard that opens the
        // analyser with this response pre-loaded. Silent success; falls back
        // to a manual textarea if the Clipboard API isn't available.
        if (responseUrl) {
          var copy = el('button', 'results-copy', { type: 'button' })
          copy.textContent = 'Copy response link'
          copy.addEventListener('click', function () {
            var restore = copy.textContent
            var done = function () {
              copy.textContent = 'Link copied'
              setTimeout(function () { copy.textContent = restore }, 2000)
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(responseUrl).then(done, function () {
                fallbackCopy(responseUrl); done()
              })
            } else {
              fallbackCopy(responseUrl); done()
            }
          })
          actions.appendChild(copy)
        }

        // Download JSON: fallback for tech-savvy authors or anyone needing the
        // raw payload (e.g. to pipe through their own aggregation).
        var json = el('button', 'results-json', { type: 'button' })
        json.textContent = 'Download data (JSON)'
        json.addEventListener('click', function () {
          var safe = String(course.id || 'survey').replace(/[^A-Za-z0-9_-]+/g, '-')
          downloadText(safe + '-response.json', payloadJson, 'application/json')
        })
        actions.appendChild(json)

        panel.appendChild(actions)
      }

      var guidance = el('p', 'results-guidance')
      guidance.textContent = res.assessed && !res.passed
        ? 'When you\u2019re ready, close this activity and reopen it to try again from the start.'
        : 'You\u2019re all done \u2014 you can close this activity.'
      panel.appendChild(guidance)

      // Small credit at the bottom of the results (survey players + PDF print).
      var byline = el('p', 'results-byline')
      byline.textContent = 'Built with AESurvey Studio by Andy Rogers \u00a9'
      panel.appendChild(byline)

      container.appendChild(panel)
      announce(announcement)
      if (status.focus) status.focus()
      if (window.scrollTo) window.scrollTo(0, 0)
    }

    // If the LMS holds a bookmark for an in-progress attempt, offer to resume.
    function maybeOfferResume(savedRaw) {
      var saved = parseInt(savedRaw, 10)
      if (isNaN(saved) || saved <= 0 || saved >= total) return
      var banner = el('div', 'resume-banner')
      var msg = el('span', 'resume-msg')
      msg.textContent = 'Welcome back \u2014 you were on Lesson ' + (saved + 1) + '.'
      var resumeBtn = el('button', 'resume-btn', { type: 'button' })
      resumeBtn.textContent = 'Resume'
      var overBtn = el('button', 'resume-over', { type: 'button' })
      overBtn.textContent = 'Start from the beginning'
      resumeBtn.addEventListener('click', function () {
        if (banner.parentNode) banner.parentNode.removeChild(banner)
        showLesson(saved)
      })
      overBtn.addEventListener('click', function () {
        if (banner.parentNode) banner.parentNode.removeChild(banner)
        window.SCORM.setLocation('0')
        showLesson(0)
      })
      banner.appendChild(msg)
      banner.appendChild(resumeBtn)
      banner.appendChild(overBtn)
      container.insertBefore(banner, lessonsWrap)
      resumeBtn.focus()
    }

    // Expose for the nav handlers declared above (hoisted), then show first.
    render.showLesson = showLesson
    var savedLocation = window.SCORM.getLocation()
    showLesson(0)
    maybeOfferResume(savedLocation)
  }

  // --- Completion ------------------------------------------------------------

  // Tally graded questions (practice + survey excluded) into the outcome the
  // results view and the LMS both need. Each graded question is worth its weight
  // (1, 2, or 3 points; default 1), so total and correct are sums of points.
  function computeResult() {
    var gradedIds = Object.keys(questions).filter(function (id) { return questions[id].graded })
    var total = 0
    var correct = 0
    var missed = []
    gradedIds.forEach(function (id) {
      var q = questions[id]
      var w = q.weight > 0 ? q.weight : 1
      total += w
      if (q.correct) correct += w
      else missed.push({ prompt: q.prompt, feedback: q.feedbackIncorrect })
    })
    var assessed = gradedIds.length > 0
    var passMark = course.passingScore == null ? 1 : course.passingScore
    var passed = assessed ? correct / total >= passMark : true
    var percent = assessed ? Math.round((correct / total) * 100) : 0
    return {
      assessed: assessed, total: total, correct: correct, missed: missed,
      passMark: passMark, passed: passed, percent: percent,
    }
  }

  // Reaching Finish completes the attempt; pass/fail is reported separately via
  // success_status. The LMS enforces "must pass" and the attempt cap, so each
  // re-launch is a fresh attempt and first-attempt data is preserved.
  function commitResult(res) {
    if (res.assessed) window.SCORM.setScore(res.correct, 0, res.total)
    window.SCORM.setResult(true, res.passed, res.assessed)
    window.SCORM.finish()
  }

  // --- Helpers ---------------------------------------------------------------

  function sameSet(a, b) {
    if (a.length !== b.length) return false
    var sa = a.slice().sort()
    var sb = b.slice().sort()
    for (var i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return false
    }
    return true
  }

  // --- Boot ------------------------------------------------------------------

  window.SCORM.init()
  render()

  // Safety net: terminate cleanly if the learner leaves without pressing Finish.
  window.addEventListener('beforeunload', function () {
    if (window.SCORM.isAvailable()) window.SCORM.finish()
  })
})()
