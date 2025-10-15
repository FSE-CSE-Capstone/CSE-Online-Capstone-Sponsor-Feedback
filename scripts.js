// scripts.js - full runnable file with globals exposed and debug logs
(function () {
  'use strict';

  // --- CONFIG: set these to your deployed Workers ---
  var ENDPOINT_URL = 'https://csesponsors.sbecerr7.workers.dev/'; // POST submissions
  var DATA_LOADER_URL = 'https://data-loader.sbecerr7.workers.dev/'; // read student/project data
  var STORAGE_KEY = 'sponsor_progress_v1';

  // --- RUBRIC ---
  var RUBRIC = [
    { title: "Effort", description: "Development effort should be balanced between all team members; student should commit to a fair amount of development effort on each sprint." },
    { title: "Meetings", description: "Students are expected to be proactive. Contributions and participation in meetings help ensure the student is aware of project goals." },
    { title: "Understanding", description: "Students are expected to understand important details of the project and be able to explain it from different stakeholder perspectives." },
    { title: "Quality", description: "Students should complete assigned work to a high quality: correct, documented, and self-explanatory where appropriate." },
    { title: "communitcation", description: "Students are expected to be in regular communication and maintain professionalism when interacting with the sponsor." }
  ];

  // --- DOM nodes ---
  var stageIdentity = document.getElementById('stage-identity');
  var stageProjects = document.getElementById('stage-projects');
  var stageThankyou = document.getElementById('stage-thankyou');
  var identitySubmit = document.getElementById('identitySubmit');
  var backToIdentity = document.getElementById('backToIdentity');
  var nameInput = document.getElementById('fullName');
  var emailInput = document.getElementById('email');
  var projectListEl = document.getElementById('project-list');
  var matrixContainer = document.getElementById('matrix-container');
  var formStatus = document.getElementById('form-status');
  var submitProjectBtn = document.getElementById('submitProject');
  var finishStartOverBtn = document.getElementById('finishStartOver');
  var underTitle = document.getElementById('under-title');

  // --- State ---
  var sponsorData = {};
  var sponsorProjects = {};
  var currentEmail = '';
  var currentName = '';
  var currentProject = '';
  var completedProjects = {};
  var stagedRatings = {};

  // --- Helpers ---
  function setStatus(msg, color) {
    if (!formStatus) return;
    formStatus.textContent = msg || '';
    formStatus.style.color = color || '';
  }
  function escapeHtml(s) {
    var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s || '').replace(/[&<>"']/g, function (m) { return map[m]; });
  }

  // Normalize rows from data-loader to array of objects
  function parseRowsFromLoader(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    // handle case where worker returned { values: [...] } (sheet API style)
    if (json.values && Array.isArray(json.values)) {
      var rows = json.values;
      var headers = (rows[0]||[]).map(h => String(h||'').trim());
      return rows.slice(1).map(r => {
        var obj = {};
        headers.forEach(function(h,i){ obj[h] = r[i] || ''; });
        return obj;
      });
    }
    // if it returned { data: [...] } or similar:
    if (Array.isArray(json.data)) return json.data;
    return [];
  }

  function buildSponsorMap(rows) {
    var map = {};
    rows.forEach(function (r) {
      var email = (r.sponsorEmail || r.email || r.SponsorEmail || r.Email || '').toString().toLowerCase().trim();
      var project = (r.project || r.Project || r.projectName || '').toString().trim();
      var student = (r.student || r.Student || r.studentName || '').toString().trim();
      if (!email || !project || !student) return;
      if (!map[email]) map[email] = { projects: {} };
      if (!map[email].projects[project]) map[email].projects[project] = [];
      if (map[email].projects[project].indexOf(student) === -1) {
        map[email].projects[project].push(student);
      }
    });
    return map;
  }

  function saveProgress() {
    var payload = { name: currentName, email: currentEmail, completedProjects: completedProjects, stagedRatings: stagedRatings };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) { console.warn('Could not save progress', e); }
  }
  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var obj = JSON.parse(raw);
      if (obj) {
        currentName = obj.name || '';
        currentEmail = obj.email || '';
        completedProjects = obj.completedProjects || {};
        stagedRatings = obj.stagedRatings || {};
        if (nameInput) nameInput.value = currentName;
        if (emailInput) emailInput.value = currentEmail;
      }
    } catch (e) { console.warn('Could not load progress', e); }
  }

  // -------------------------
  // Project list builder
  // -------------------------
  function populateProjectListFor(email) {
    if (!projectListEl) return;
    projectListEl.innerHTML = '';
    sponsorProjects = {};
    var entry = sponsorData[email];
    if (!entry || !entry.projects) {
      setStatus('No projects found for that email.', 'red');
      return;
    }
    var allProjects = Object.keys(entry.projects).slice();
    allProjects.sort(function (a, b) {
      var ca = completedProjects[a] ? 1 : 0;
      var cb = completedProjects[b] ? 1 : 0;
      return ca - cb;
    });

    allProjects.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'project-item';
      li.tabIndex = 0;
      li.setAttribute('data-project', p);

      if (completedProjects[p]) {
        li.className += ' completed';
        li.innerHTML = '<strong>' + escapeHtml(p) + '</strong> <span class="meta">(completed)</span>';
      } else {
        li.innerHTML = '<strong>' + escapeHtml(p) + '</strong>';
      }

      li.addEventListener('click', function () {
        if (completedProjects[p]) {
          setStatus('This project is already completed.', 'red');
          return;
        }
        var act = projectListEl.querySelectorAll('.project-item.active');
        for (var ai = 0; ai < act.length; ai++) act[ai].classList.remove('active');
        li.classList.add('active');
        // This call must be available globally if HTML calls it directly.
        loadProjectIntoMatrix(p, entry.projects[p]);
        setStatus('');
      });

      projectListEl.appendChild(li);
      sponsorProjects[p] = entry.projects[p].slice();
    });

    setStatus('');
  }

  // -------------------------
  // Render matrix for a project
  // -------------------------
  function loadProjectIntoMatrix(projectName, students) {
    console.log('loadProjectIntoMatrix called:', projectName, students);
    currentProject = projectName;
    if (!matrixContainer) return;

    // cleanup old
    var oldInfo = document.getElementById('matrix-info');
    if (oldInfo && oldInfo.parentNode) oldInfo.parentNode.removeChild(oldInfo);

    matrixContainer.innerHTML = '';
    var oldComment = document.querySelector('.section.section-comment');
    if (oldComment && oldComment.parentNode) oldComment.parentNode.removeChild(oldComment);

    // header
    var info = document.createElement('div');
    info.id = 'matrix-info';
    var hdr = document.createElement('div');
    hdr.className = 'current-project-header';
    hdr.textContent = projectName || '';
    hdr.style.display = 'block';
    hdr.style.marginBottom = '6px';
    hdr.style.fontWeight = '600';
    var topDesc = document.createElement('div');
    topDesc.className = 'matrix-info-desc';
    topDesc.textContent = 'Please evaluate the students using the rubric below (scale 1–7).';
    topDesc.style.display = 'block';
    topDesc.style.color = '#0b1228';
    topDesc.style.fontWeight = '400';
    topDesc.style.fontSize = '14px';
    topDesc.style.marginBottom = '12px';
    info.appendChild(hdr);
    info.appendChild(topDesc);
    if (matrixContainer.parentNode) matrixContainer.parentNode.insertBefore(info, matrixContainer);
    else document.body.insertBefore(info, matrixContainer);

    if (!students || !students.length) {
      matrixContainer.textContent = 'No students found for this project.';
      return;
    }

    if (!stagedRatings[currentProject]) stagedRatings[currentProject] = {};

    RUBRIC.forEach(function (crit, cIdx) {
      var card = document.createElement('div');
      card.className = 'card matrix-card';
      card.style.marginBottom = '20px';
      card.style.padding = card.style.padding || '18px';

      var critWrap = document.createElement('div');
      critWrap.className = 'matrix-criterion';

      var critTitle = document.createElement('h4');
      critTitle.className = 'matrix-criterion-title';
      critTitle.textContent = (cIdx + 1) + '. ' + (crit.title || '');
      critTitle.style.margin = '0 0 8px 0';
      critTitle.style.fontWeight = '600';
      critWrap.appendChild(critTitle);

      var critDesc = document.createElement('div');
      critDesc.className = 'matrix-criterion-desc';
      critDesc.textContent = crit.description || '';
      critDesc.style.display = 'block';
      critDesc.style.color = '#0b1228';
      critDesc.style.fontWeight = '400';
      critDesc.style.fontSize = '14px';
      critDesc.style.lineHeight = '1.3';
      critDesc.style.margin = '0 0 12px 0';
      critWrap.appendChild(critDesc);

      var table = document.createElement('table');
      table.className = 'matrix-table';
      table.style.width = '100%';
      var thead = document.createElement('thead');
      var trHead = document.createElement('tr');

      var thName = document.createElement('th');
      thName.textContent = 'Student';
      thName.style.textAlign = 'left';
      thName.style.padding = '8px';
      trHead.appendChild(thName);

      for (var k = 1; k <= 7; k++) {
        var th = document.createElement('th');
        th.textContent = String(k);
        th.style.padding = '8px';
        th.style.textAlign = 'center';
        trHead.appendChild(th);
      }
      thead.appendChild(trHead);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');

      students.forEach(function (studentName, sIdx) {
        var tr = document.createElement('tr');
        var tdName = document.createElement('td');
        tdName.textContent = studentName;
        tdName.style.padding = '8px 10px';
        tdName.style.verticalAlign = 'middle';
        tr.appendChild(tdName);

        for (var score = 1; score <= 7; score++) {
          var td = document.createElement('td');
          td.style.textAlign = 'center';
          td.style.padding = '8px';

          var input = document.createElement('input');
          input.type = 'radio';
          input.name = 'rating-' + cIdx + '-' + sIdx;
          input.value = String(score);
          input.id = 'rating-' + cIdx + '-' + sIdx + '-' + score;

          var stagedForProject = stagedRatings[currentProject] || {};
          var stagedForStudent = stagedForProject[sIdx] || {};
          if (stagedForStudent[cIdx] && String(stagedForStudent[cIdx]) === String(score)) {
            input.checked = true;
          }

          var label = document.createElement('label');
          label.setAttribute('for', input.id);
          label.style.cursor = 'pointer';
          label.style.display = 'inline-block';
          label.style.padding = '2px';
          label.appendChild(input);
          td.appendChild(label);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      critWrap.appendChild(table);
      card.appendChild(critWrap);
      matrixContainer.appendChild(card);
    });

    var commentSec = document.createElement('div');
    commentSec.className = 'section section-comment';
    commentSec.style.marginTop = '12px';

    var commentWrap = document.createElement('div');
    commentWrap.className = 'project-comment-wrap';
    var commentLabel = document.createElement('label');
    commentLabel.setAttribute('for', 'project-comment');
    commentLabel.textContent = 'Optional project comment';
    commentLabel.style.display = 'block';
    commentLabel.style.marginBottom = '6px';
    var commentTA = document.createElement('textarea');
    commentTA.id = 'project-comment';
    commentTA.placeholder = 'Any additional feedback for the students or instructor...';
    commentTA.style.width = '100%';
    commentTA.style.minHeight = '80px';
    commentTA.style.padding = '8px';

    var stagedComment = stagedRatings[currentProject] && stagedRatings[currentProject]._comment;
    if (stagedComment) commentTA.value = stagedComment;

    commentWrap.appendChild(commentLabel);
    commentWrap.appendChild(commentTA);
    commentSec.appendChild(commentWrap);

    if (matrixContainer.parentNode) matrixContainer.parentNode.insertBefore(commentSec, matrixContainer.nextSibling);
    else document.body.appendChild(commentSec);

    // replace container to remove duplicate handlers
    var newMatrixContainer = matrixContainer.cloneNode(false);
    while (matrixContainer.firstChild) newMatrixContainer.appendChild(matrixContainer.firstChild);
    matrixContainer.parentNode.replaceChild(newMatrixContainer, matrixContainer);
    matrixContainer = newMatrixContainer;

    matrixContainer.addEventListener('change', saveDraftHandler);
    matrixContainer.addEventListener('input', saveDraftHandler);
    commentTA.addEventListener('input', saveDraftHandler);
  }

  // -------------------------
  // Draft saving handler
  // -------------------------
  function saveDraftHandler() {
    if (!currentProject) return;
    if (!stagedRatings[currentProject]) stagedRatings[currentProject] = {};

    var students = sponsorProjects[currentProject] || [];
    for (var s = 0; s < students.length; s++) {
      if (!stagedRatings[currentProject][s]) stagedRatings[currentProject][s] = {};
      for (var c = 0; c < RUBRIC.length; c++) {
        var sel = document.querySelector('input[name="rating-' + c + '-' + s + '"]:checked');
        if (sel) stagedRatings[currentProject][s][c] = parseInt(sel.value, 10);
        else if (stagedRatings[currentProject][s][c] === undefined) stagedRatings[currentProject][s][c] = null;
      }
    }
    var ta = document.getElementById('project-comment');
    if (ta) stagedRatings[currentProject]._comment = ta.value || '';

    saveProgress();
  }

  // -------------------------
  // Submit current project (collect all criteria)
  // -------------------------
  function submitCurrentProject() {
    console.log('submitCurrentProject called for', currentProject);
    if (!currentProject) { setStatus('No project is loaded.', 'red'); return; }
    var students = sponsorProjects[currentProject] || [];
    if (!students.length) { setStatus('No students to submit.', 'red'); return; }

    var rows = [];
    for (var s = 0; s < students.length; s++) {
      var ratingsObj = {};
      for (var c = 0; c < RUBRIC.length; c++) {
        var sel = document.querySelector('input[name="rating-' + c + '-' + s + '"]:checked');
        ratingsObj[RUBRIC[c].title] = sel ? parseInt(sel.value, 10) : null;
      }
      var commentVal = '';
      var taEl = document.getElementById('project-comment');
      if (taEl) commentVal = taEl.value || '';
      rows.push({ student: students[s], ratings: ratingsObj, comment: commentVal });
    }

    var anyRated = rows.some(function (r) {
      return Object.keys(r.ratings).some(function (k) { return r.ratings[k] != null; });
    });
    if (!anyRated) { setStatus('Please rate at least one student before submitting.', 'red'); return; }

    var payload = {
      sponsorName: currentName || (nameInput ? nameInput.value.trim() : ''),
      sponsorEmail: currentEmail || (emailInput ? emailInput.value.trim() : ''),
      project: currentProject,
      rubric: RUBRIC.map(function (r) { return r.title; }),
      responses: rows,
      timestamp: new Date().toISOString()
    };

    setStatus('Submitting...', 'black');
    if (submitProjectBtn) submitProjectBtn.disabled = true;

    fetch(ENDPOINT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (txt) { throw new Error('Server error ' + resp.status + ': ' + txt); });
      }
      return resp.json().catch(function () { return {}; });
    }).then(function (data) {
      console.log('Saved', data);
      setStatus('Submission saved. Thank you!', 'green');

      completedProjects[currentProject] = true;
      if (stagedRatings && stagedRatings[currentProject]) delete stagedRatings[currentProject];
      saveProgress();

      if (projectListEl) {
        var li = projectListEl.querySelector('li[data-project="' + CSS.escape(currentProject) + '"]');
        if (li) {
          li.classList.add('completed');
          li.classList.remove('active');
          li.innerHTML = '<strong>' + escapeHtml(currentProject) + '</strong> <span class="meta">(completed)</span>';
        }
      }

      if (matrixContainer) matrixContainer.innerHTML = '';
      var commentSection = document.querySelector('.section.section-comment');
      if (commentSection) commentSection.parentNode && commentSection.parentNode.removeChild(commentSection);

      var headerEl = document.querySelector('.current-project-header');
      if (headerEl && headerEl.parentNode) headerEl.parentNode.removeChild(headerEl);

      var matrixInfoBlock = document.getElementById('matrix-info');
      if (matrixInfoBlock) matrixInfoBlock.style.display = 'none';

      currentProject = '';
      if (hasCompletedAllProjects()) showThankyouStage();
    }).catch(function (err) {
      console.error('Submission failed', err);
      setStatus('Submission failed. See console.', 'red');
    }).finally(function () {
      if (submitProjectBtn) submitProjectBtn.disabled = false;
    });
  }

  function hasCompletedAllProjects() {
    var entry = sponsorData[currentEmail] || {};
    var all = Object.keys(entry.projects || {});
    if (!all || all.length === 0) return false;
    for (var i = 0; i < all.length; i++) if (!completedProjects[all[i]]) return false;
    return true;
  }

  // -------------------------
  // Identity / events
  // -------------------------
  function tryFetchData(callback) {
    var loaderUrl = DATA_LOADER_URL;
    // if you want online vs hybrid, append ?source=online
    // loaderUrl += '?source=online';
    fetch(loaderUrl, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('Data loader returned ' + r.status);
      return r.json();
    }).then(function (rowsJson) {
      var rows = parseRowsFromLoader(rowsJson);
      sponsorData = buildSponsorMap(rows);
      setStatus('Project data loaded. Enter your email to continue.', 'green');
      loadProgress();
      if (currentEmail && sponsorData[currentEmail]) {
        showProjectsStage();
        populateProjectListFor(currentEmail);
      }
      if (typeof callback === 'function') callback();
    }).catch(function (err) {
      console.error('Data loader fetch failed', err);
      setStatus('Project data not found. Contact admin.', 'red');
      if (typeof callback === 'function') callback();
    });
  }

  function onIdentitySubmit() {
    var name = nameInput ? nameInput.value.trim() : '';
    var email = emailInput ? (emailInput.value || '').toLowerCase().trim() : '';
    if (!name) { setStatus('Please enter your name.', 'red'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setStatus('Please enter a valid email.', 'red'); return; }

    currentName = name;
    currentEmail = email;
    saveProgress();

    if (!sponsorData || Object.keys(sponsorData).length === 0) {
      setStatus('Loading project data, please wait...', 'black');
      tryFetchData(function () {
        if (!sponsorData || !sponsorData[currentEmail]) {
          setStatus('No projects found for that email.', 'red');
          return;
        }
        showProjectsStage();
        populateProjectListFor(currentEmail);
      });
    } else {
      if (!sponsorData[currentEmail]) { setStatus('No projects found for that email.', 'red'); return; }
      showProjectsStage();
      populateProjectListFor(currentEmail);
    }
  }

  if (identitySubmit) identitySubmit.addEventListener('click', onIdentitySubmit);
  if (backToIdentity) backToIdentity.addEventListener('click', function () { showIdentityStage(); });
  if (submitProjectBtn) submitProjectBtn.addEventListener('click', function () { submitCurrentProject(); });
  if (finishStartOverBtn) finishStartOverBtn.addEventListener('click', function () {
    completedProjects = {};
    stagedRatings = {};
    saveProgress();
    currentProject = '';
    if (matrixContainer) matrixContainer.innerHTML = '';
    var commentSection = document.querySelector('.section.section-comment');
    if (commentSection) { commentSection.parentNode && commentSection.parentNode.removeChild(commentSection); }
    showIdentityStage();
  });

  function showIdentityStage() {
    if (stageIdentity) stageIdentity.style.display = '';
    if (stageProjects) stageProjects.style.display = 'none';
    if (stageThankyou) stageThankyou.style.display = 'none';
    if (underTitle) underTitle.style.display = '';
    setStatus('');
  }
  function showProjectsStage() {
    if (stageIdentity) stageIdentity.style.display = 'none';
    if (stageProjects) stageProjects.style.display = '';
    if (stageThankyou) stageThankyou.style.display = 'none';
  }
  function showThankyouStage() {
    if (stageIdentity) stageIdentity.style.display = 'none';
    if (stageProjects) stageProjects.style.display = 'none';
    if (stageThankyou) stageThankyou.style.display = '';
  }

  // Boot
  showIdentityStage();

  // Expose these functions in case your HTML uses inline handlers or external scripts
  window.loadProjectIntoMatrix = loadProjectIntoMatrix;
  window.submitCurrentProject = submitCurrentProject;
  // Also expose a debug reload helper
  window.__sponsorDebug = {
    reloadData: function(cb){ tryFetchData(cb); },
    sponsorData: sponsorData
  };

})(); // end IIFE







