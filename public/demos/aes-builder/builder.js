/*
 * AES Survey Builder — standalone client-side authoring UI.
 *
 * Produces a Course object matching src/content/model.ts, encoded as
 * base64 in a URL fragment ("#s=<b64>"). The take page at /demos/aes-survey/
 * decodes and renders it.
 *
 * No dependencies, no build step. Works from file:// or a static host.
 */
;(function () {
  'use strict'

  var BANDS = [
    { value: 'alarming', label: 'Alarming' },
    { value: 'concerning', label: 'Concerning' },
    { value: 'acceptable', label: 'Acceptable' },
    { value: 'superior', label: 'Superior' },
  ]

  // Where the take page lives, relative to the builder's URL. Using an
  // explicit index.html so the link works in both Astro dev (which doesn't
  // auto-serve directory index files) and static hosting (Netlify etc.).
  var TAKE_PATH = '../aes-survey/index.html'

  // Model — kept as a plain JS object we mutate as inputs change. On any
  // "action" (copy link, preview, etc.) we serialise this to JSON.
  var state = emptyState()

  function emptyState() {
    return {
      title: '',
      description: '',
      authorName: '',
      authorEmail: '',
      questions: [], // { prompt, kind, reference, comment, statements: [{text, band}] }
    }
  }

  function newQuestion() {
    return {
      prompt: '',
      kind: 'opinion',
      reference: '',
      comment: true,
      statements: BANDS.map(function (b) { return { text: '', band: b.value } }),
    }
  }

  // ---- DOM helpers -------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k]
        else if (k === 'text') node.textContent = attrs[k]
        else if (k === 'html') node.innerHTML = attrs[k]
        else node.setAttribute(k, attrs[k])
      })
    }
    if (children) children.forEach(function (c) { if (c) node.appendChild(c) })
    return node
  }

  // ---- Rendering ---------------------------------------------------------

  function render() {
    var host = document.getElementById('questions')
    host.innerHTML = ''
    if (!state.questions.length) {
      var empty = el('p', { class: 'cap', text: 'No questions yet. Add one to get started.' })
      host.appendChild(empty)
      return
    }
    state.questions.forEach(function (q, qi) { host.appendChild(renderQuestion(q, qi)) })
  }

  function renderQuestion(q, qi) {
    var card = el('div', { class: 'card' })

    // Card header: question number + delete
    var head = el('div', { class: 'card-head' })
    head.appendChild(el('div', { class: 'card-title', text: 'Question ' + (qi + 1) }))
    var del = el('button', { class: 'btn danger', type: 'button', text: 'Remove question' })
    del.addEventListener('click', function () {
      if (confirm('Remove this question?')) {
        state.questions.splice(qi, 1)
        render()
        status('Question removed.')
      }
    })
    head.appendChild(del)
    card.appendChild(head)

    // Prompt
    var promptField = el('div', { class: 'field' })
    var promptLabel = el('label', { for: 'q' + qi + '-prompt', text: 'Prompt (unbiased, open question)' })
    var promptInput = el('textarea', {
      id: 'q' + qi + '-prompt',
      rows: '2',
      placeholder: 'e.g. How well has the workshop prepared you to give feedback in real situations?',
    })
    promptInput.value = q.prompt
    promptInput.addEventListener('input', function () { q.prompt = promptInput.value })
    promptField.appendChild(promptLabel)
    promptField.appendChild(promptInput)
    card.appendChild(promptField)

    // Kind + reference
    var row = el('div', { class: 'fields-row' })
    var kindField = el('div', { class: 'field' })
    kindField.appendChild(el('label', { for: 'q' + qi + '-kind', text: 'Question kind' }))
    var kindSel = el('select', { id: 'q' + qi + '-kind' })
    ;[
      { value: 'opinion', label: 'Opinion (how the respondent feels)' },
      { value: 'behaviour', label: 'Behaviour (what they will/do do)' },
    ].forEach(function (opt) {
      var o = el('option', { value: opt.value, text: opt.label })
      if (q.kind === opt.value) o.selected = true
      kindSel.appendChild(o)
    })
    kindSel.addEventListener('change', function () { q.kind = kindSel.value })
    kindField.appendChild(kindSel)
    row.appendChild(kindField)

    var refField = el('div', { class: 'field' })
    refField.appendChild(el('label', {
      for: 'q' + qi + '-ref',
      text: 'Reference (short slug, optional)',
    }))
    var refInput = el('input', {
      id: 'q' + qi + '-ref',
      type: 'text',
      placeholder: 'e.g. prepared-to-apply',
    })
    refInput.value = q.reference
    refInput.addEventListener('input', function () { q.reference = refInput.value })
    refField.appendChild(refInput)
    row.appendChild(refField)
    card.appendChild(row)

    // Comment checkbox
    var commentField = el('div', { class: 'field' })
    var commentLabel = el('label', { for: 'q' + qi + '-comment' })
    var commentBox = el('input', { id: 'q' + qi + '-comment', type: 'checkbox' })
    commentBox.checked = q.comment !== false
    commentBox.addEventListener('change', function () { q.comment = commentBox.checked })
    commentLabel.style.display = 'flex'
    commentLabel.style.alignItems = 'center'
    commentLabel.style.gap = '8px'
    commentLabel.appendChild(commentBox)
    commentLabel.appendChild(document.createTextNode('Show an optional free-text comment box'))
    commentField.appendChild(commentLabel)
    card.appendChild(commentField)

    // Statements
    var stmtHead = el('h3', { text: 'Statements' })
    stmtHead.style.marginTop = '16px'
    card.appendChild(stmtHead)
    card.appendChild(el('p', {
      class: 'cap',
      text: 'The four+ options a respondent can pick between. Each is tagged to a band.',
    }))

    var stmtHost = el('div')
    card.appendChild(stmtHost)
    q.statements.forEach(function (s, si) {
      stmtHost.appendChild(renderStatement(q, qi, si, s))
    })

    var addStmt = el('button', {
      class: 'btn subtle', type: 'button', text: '+ Add statement',
    })
    addStmt.addEventListener('click', function () {
      q.statements.push({ text: '', band: 'acceptable' })
      render()
      status('Statement added.')
    })
    card.appendChild(addStmt)

    return card
  }

  function renderStatement(q, qi, si, s) {
    var row = el('div', { class: 'statement' })
    var textInput = el('input', {
      type: 'text',
      placeholder: 'e.g. I could give useful feedback in most situations.',
      'aria-label': 'Statement text',
    })
    textInput.value = s.text
    textInput.addEventListener('input', function () { s.text = textInput.value })
    row.appendChild(textInput)

    var bandSel = el('select', { 'aria-label': 'Band' })
    BANDS.forEach(function (b) {
      var o = el('option', { value: b.value, text: b.label })
      if (s.band === b.value) o.selected = true
      bandSel.appendChild(o)
    })
    bandSel.addEventListener('change', function () { s.band = bandSel.value })
    row.appendChild(bandSel)

    var remove = el('button', {
      class: 'btn danger', type: 'button', text: 'Remove',
      'aria-label': 'Remove statement',
    })
    remove.addEventListener('click', function () {
      if (q.statements.length <= 2) {
        status('A question needs at least two statements.', 'err')
        return
      }
      q.statements.splice(si, 1)
      render()
    })
    row.appendChild(remove)
    return row
  }

  // ---- Read UI back into model + validate ---------------------------------

  function pullFromForm() {
    state.title = document.getElementById('title').value.trim()
    state.description = document.getElementById('description').value.trim()
    state.authorName = document.getElementById('author-name').value.trim()
    state.authorEmail = document.getElementById('author-email').value.trim()
  }

  function validate() {
    pullFromForm()
    if (!state.title) return 'Please add a survey title.'
    if (!state.questions.length) return 'Add at least one question.'
    for (var i = 0; i < state.questions.length; i++) {
      var q = state.questions[i]
      if (!q.prompt.trim()) return 'Question ' + (i + 1) + ' needs a prompt.'
      if (!q.statements.length) return 'Question ' + (i + 1) + ' needs statements.'
      var bands = {}
      for (var j = 0; j < q.statements.length; j++) {
        var s = q.statements[j]
        if (!s.text.trim()) return 'Question ' + (i + 1) + ' has a blank statement.'
        bands[s.band] = true
      }
    }
    return null
  }

  // ---- Serialise to the Course model ---------------------------------------

  var slugCounter = 0
  function nextId(prefix) { slugCounter++; return prefix + '-' + Date.now().toString(36) + '-' + slugCounter }
  function slug(text, fallback) {
    var s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return s || fallback
  }

  function buildCourse() {
    var id = slug(state.title, 'aes-survey')
    var blocks = state.questions.map(function (q, i) {
      var qId = q.reference ? slug(q.reference, 'q' + (i + 1)) : 'q' + (i + 1)
      var ref = q.reference ? slug(q.reference, qId) : ''
      return {
        id: qId,
        type: 'survey',
        prompt: q.prompt,
        reference: ref,
        surveyKind: q.kind,
        comment: q.comment !== false,
        options: q.statements.map(function (s, si) {
          return { id: 'o' + (si + 1), category: s.band, text: s.text }
        }),
      }
    })
    var course = {
      id: id,
      title: state.title,
      passingScore: 1,
      completionRule: 'finish',
      authorName: state.authorName || undefined,
      authorEmail: state.authorEmail || undefined,
      lessons: [{ id: 'lesson-1', title: 'Your experience', blocks: blocks }],
    }
    if (state.description) course.description = state.description
    return course
  }

  function encodeCourseToLink(course) {
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(course))))
    var origin = window.location.origin
    // If served from a file:// URL, fall back to andyrogers.design so shared
    // links still work on the deployed site.
    var base = (origin && origin.indexOf('http') === 0)
      ? origin + window.location.pathname.replace(/[^/]*$/, '') + TAKE_PATH
      : 'https://andyrogers.design/demos/aes-survey/'
    return base + '#s=' + b64
  }

  // ---- Actions -------------------------------------------------------------

  function status(msg, kind) {
    var s = document.getElementById('status')
    s.textContent = msg || ''
    s.className = 'status' + (kind ? ' ' + kind : '')
    if (msg && kind !== 'err') setTimeout(function () {
      if (s.textContent === msg) s.textContent = ''
    }, 4000)
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        document.body.appendChild(ta)
        ta.focus(); ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        resolve()
      } catch (e) { reject(e) }
    })
  }

  document.getElementById('copy-link').addEventListener('click', function () {
    var err = validate()
    if (err) return status(err, 'err')
    var link = encodeCourseToLink(buildCourse())
    copyToClipboard(link).then(function () {
      status('Shareable link copied to clipboard. Send it to your respondents.', 'ok')
    }, function () {
      status('Couldn\u2019t copy automatically. Here it is: ' + link, 'err')
    })
  })

  document.getElementById('preview').addEventListener('click', function () {
    var err = validate()
    if (err) return status(err, 'err')
    var link = encodeCourseToLink(buildCourse())
    window.open(link, '_blank', 'noopener')
    status('Preview opened in a new tab.', 'ok')
  })

  document.getElementById('copy-config').addEventListener('click', function () {
    var err = validate()
    if (err) return status(err, 'err')
    var json = JSON.stringify(buildCourse(), null, 2)
    copyToClipboard(json).then(function () {
      status('Config JSON copied. Paste it into src/content/demo.ts (or similar) to bake it into a SCORM build.', 'ok')
    }, function () { status('Couldn\u2019t copy. Try the browser console.', 'err') })
  })

  document.getElementById('load-demo').addEventListener('click', function () {
    state = demoState()
    fillForm()
    render()
    status('Demo survey loaded.', 'ok')
  })

  document.getElementById('reset').addEventListener('click', function () {
    if (!confirm('Clear everything and start again?')) return
    state = emptyState()
    fillForm()
    render()
    status('Reset.')
  })

  document.getElementById('add-question').addEventListener('click', function () {
    state.questions.push(newQuestion())
    render()
    var host = document.getElementById('questions')
    host.lastChild && host.lastChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })

  // Live-update the basics on input.
  ;['title', 'description', 'author-name', 'author-email'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', pullFromForm)
  })

  function fillForm() {
    document.getElementById('title').value = state.title
    document.getElementById('description').value = state.description
    document.getElementById('author-name').value = state.authorName
    document.getElementById('author-email').value = state.authorEmail
  }

  // ---- Demo state ----------------------------------------------------------

  function demoState() {
    return {
      title: 'Giving Effective Feedback \u2014 Experience Survey',
      description: 'A two-minute survey about the workshop you just completed. There are no right answers; pick the statement that fits you best.',
      authorName: 'Andy',
      authorEmail: 'hello@andyrogers.design',
      questions: [
        {
          prompt: 'How well has the workshop prepared you to give feedback in real situations?',
          kind: 'opinion', reference: 'prepared-to-apply', comment: true,
          statements: [
            { text: 'I still wouldn\u2019t know where to start.', band: 'alarming' },
            { text: 'I understand the theory, but I couldn\u2019t do it yet without help.', band: 'concerning' },
            { text: 'I could give useful feedback in most situations.', band: 'acceptable' },
            { text: 'I feel ready to give clear, kind feedback in any situation.', band: 'superior' },
          ],
        },
        {
          prompt: 'How well did the examples reflect the kind of conversations you actually have?',
          kind: 'opinion', reference: 'example-relevance', comment: true,
          statements: [
            { text: 'None of them were relevant to my work.', band: 'alarming' },
            { text: 'A few were relevant, but most were not.', band: 'concerning' },
            { text: 'Most examples matched situations I recognise.', band: 'acceptable' },
            { text: 'The examples could have been taken straight from my week.', band: 'superior' },
          ],
        },
        {
          prompt: 'Thinking about the next two weeks, what will you do differently?',
          kind: 'behaviour', reference: 'intended-use', comment: true,
          statements: [
            { text: 'Honestly, I don\u2019t expect to change anything.', band: 'alarming' },
            { text: 'I might try one idea if the moment comes up.', band: 'concerning' },
            { text: 'I plan to use a couple of the techniques deliberately.', band: 'acceptable' },
            { text: 'I\u2019ve already planned a specific conversation to apply this to.', band: 'superior' },
          ],
        },
        {
          prompt: 'When you next need to give difficult feedback, how will you approach it?',
          kind: 'behaviour', reference: 'approach-to-difficult', comment: true,
          statements: [
            { text: 'I\u2019ll avoid it, as I usually do.', band: 'alarming' },
            { text: 'I\u2019ll push through it but expect it to go badly.', band: 'concerning' },
            { text: 'I\u2019ll use a structure from the workshop to keep it on track.', band: 'acceptable' },
            { text: 'I\u2019ll plan it, use the structure, and follow up afterwards.', band: 'superior' },
          ],
        },
      ],
    }
  }

  // Boot with one empty question so the form is never bare.
  state.questions.push(newQuestion())
  render()
})()
