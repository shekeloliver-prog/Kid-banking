import { h, setBusy } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { meter, pill, toast, confetti, emptyState } from '../../ui.js';

const streakText = (n) => (n > 0 ? `${n}-day streak` : 'No streak yet');

/** The "Money Smarts" hub: progress, streak, and every lesson. */
export const learnView = defineView({
  title: 'Learn',
  load: () => api.get('/kid/learn'),
  render: (d) => {
    const next = d.lessons.find((l) => !l.passed);
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Money Smarts 💡'), h('p', null, 'Quick lessons, then a mini quiz. No money involved, just brain power.'))),
      h('section', { class: 'card learn-hero' },
        h('div', { class: 'spread', style: { alignItems: 'flex-start', gap: '12px' } },
          h('div', { class: 'grow' }, h('div', { class: 'row-title', style: { marginBottom: '10px' } }, d.passedCount === d.total ? '🎓 You passed every lesson!' : `${d.passedCount} of ${d.total} lessons passed`), meter({ label: 'Progress', value: d.passedCount, max: d.total, textRight: `${Math.round((d.passedCount / d.total) * 100)}%`, tone: 'pos' })),
          pill(`🔥 ${streakText(d.streak)}`, d.streak ? 'warn' : '')),
        h('p', { class: 'small muted', style: { marginTop: '12px' } }, d.doneToday ? 'You learned something today. Come back tomorrow to keep your streak going!' : d.streak ? 'Pass a lesson today to keep your streak alive.' : 'Pass a lesson on 3 days in a row to earn the On a Roll badge.'),
        next ? h('a', { class: 'btn btn-accent', href: `#/learn/${next.key}`, style: { marginTop: '14px' } }, icon('play', 17), d.passedCount ? `Next: ${next.title}` : 'Start your first lesson') : null),
      h('div', { class: 'grid grid-2' }, d.lessons.map(lessonCard)),
    );
  },
});

function lessonCard(l) {
  return h(
    'a',
    { class: `card lesson-card ${l.passed ? 'passed' : ''}`, href: `#/learn/${l.key}`, 'aria-label': `${l.title}. ${l.passed ? 'Passed' : 'Not passed yet'}` },
    h('span', { class: 'lesson-emoji', 'aria-hidden': 'true' }, l.emoji),
    h('div', { class: 'grow' },
      h('div', { class: 'row-title' }, l.title),
      h('div', { class: 'row-sub' }, l.blurb),
      h('div', { class: 'cluster', style: { marginTop: '8px', gap: '6px' } }, l.passed ? pill(`Passed · best ${l.bestCorrect}/${l.questions}`, 'pos', 'check') : l.attempts ? pill(`Best so far ${l.bestCorrect}/${l.questions}`, 'warn') : pill(`${l.minutes} min`, ''))),
    icon('right', 18),
  );
}

/** One lesson: read → quiz → results. The server scores it, so the answers only appear after you submit. */
export const lessonView = defineView({
  title: 'Lesson',
  load: async ({ key }) => {
    try {
      const [lesson, progress] = await Promise.all([api.get(`/kid/learn/${encodeURIComponent(key)}`), api.get('/kid/learn')]);
      return { lesson, progress };
    } catch (err) {
      if (err.status === 404) return { missing: true };
      throw err;
    }
  },
  render: (d) =>
    d.missing
      ? h('div', { class: 'card' }, emptyState({ emoji: '🤔', title: 'We can’t find that lesson', text: 'It may have moved. Pick one from the list.', action: h('a', { class: 'btn btn-accent', href: '#/learn' }, 'See all lessons') }))
      : flow(d.lesson, d.progress),
});

function flow(lesson, progress) {
  const root = h('div', { class: 'stack-lg' });
  const total = lesson.questions.length;
  let answers = [];
  let qi = 0;
  let result = null;
  let submitted = [];
  let submitting = false;
  const lessonsList = progress.lessons.map((l) => ({ ...l }));

  const back = h('a', { class: 'back-link', href: '#/learn' }, icon('left', 16), 'All lessons');
  const title = (text) => h('h1', { tabindex: '-1', id: 'lesson-title' }, text);
  const focusTitle = () => queueMicrotask(() => root.querySelector('#lesson-title')?.focus({ preventScroll: true }));

  function read() {
    root.replaceChildren(
      back,
      h('header', { class: 'lesson-head' }, h('span', { class: 'lesson-emoji big', 'aria-hidden': 'true' }, lesson.emoji), h('div', null, title(lesson.title), h('p', { class: 'muted' }, `About ${lesson.minutes} minutes`))),
      h('div', { class: 'stack' }, lesson.learn.map((t, i) => h('div', { class: 'card learn-point' }, h('span', { class: 'num', 'aria-hidden': 'true' }, String(i + 1)), h('p', null, t)))),
      h('div', null, h('button', { class: 'btn btn-accent btn-lg', onClick: () => { qi = 0; quiz(); } }, 'Take the quiz', icon('right', 18))),
    );
    focusTitle();
  }

  function quiz() {
    const q = lesson.questions[qi];
    const last = qi === total - 1;
    const next = h('button', { class: 'btn btn-accent btn-lg', disabled: answers[qi] === undefined }, last ? 'Check my answers' : 'Next', icon(last ? 'check' : 'right', 18));
    const options = q.options.map((text, i) =>
      h('button', {
        type: 'button',
        class: 'quiz-option',
        'aria-pressed': String(answers[qi] === i),
        onClick: () => {
          if (submitting) return;
          answers[qi] = i;
          options.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
          next.disabled = false;
        },
      }, h('span', { class: 'letter', 'aria-hidden': 'true' }, String.fromCharCode(65 + i)), h('span', null, text)),
    );
    next.addEventListener('click', async () => {
      if (!last) {
        qi++;
        quiz();
        return;
      }
      setBusy(next, true);
      submitting = true;
      root.querySelectorAll('.quiz-option, .quiz-back').forEach((b) => (b.disabled = true));
      try {
        submitted = [...answers]; // what was sent is what the review shows, whatever happens to the form meanwhile
        result = await api.post(`/kid/learn/${encodeURIComponent(lesson.key)}`, { answers: submitted });
        const row = lessonsList.find((l) => l.key === lesson.key);
        if (row && result.passed) row.passed = true;
        finish();
      } catch (err) {
        toast(err.message, { tone: 'error' });
        setBusy(next, false);
        root.querySelectorAll('.quiz-option, .quiz-back').forEach((b) => (b.disabled = false));
      } finally {
        submitting = false;
      }
    });
    root.replaceChildren(
      back,
      h('div', { class: 'quiz-progress', role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': total, 'aria-valuenow': qi + 1, 'aria-label': `Question ${qi + 1} of ${total}` }, Array.from({ length: total }, (_, i) => h('span', { class: i < qi ? 'done' : i === qi ? 'now' : '' }))),
      h('section', { class: 'card quiz-card' },
        h('div', { class: 'tiny muted', style: { fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' } }, `Question ${qi + 1} of ${total}`),
        h('h2', { id: 'lesson-title', tabindex: '-1', class: 'quiz-q' }, q.q),
        h('div', { class: 'stack-sm', role: 'group', 'aria-labelledby': 'lesson-title' }, options)),
      h('div', { class: 'cluster' }, qi > 0 ? h('button', { class: 'btn btn-ghost quiz-back', onClick: () => { qi--; quiz(); } }, icon('left', 16), 'Back') : null, next),
    );
    focusTitle();
  }

  function finish() {
    const r = result;
    const perfect = r.correct === r.total;
    const upNext = lessonsList.find((l) => !l.passed && l.key !== lesson.key) ?? lessonsList.find((l) => !l.passed);
    if (r.passed) confetti();
    for (const b of r.newBadges) toast(`New badge: ${b.title}!`, { emoji: b.emoji });
    root.replaceChildren(
      back,
      h('section', { class: `card result ${r.passed ? 'pass' : 'retry'}` },
        h('div', { class: 'result-emoji', 'aria-hidden': 'true' }, perfect ? '🌟' : r.passed ? '🎉' : '💪'),
        title(r.passed ? (perfect ? 'Perfect score!' : 'You passed!') : 'Almost there!'),
        h('p', { class: 'result-score' }, `You got ${r.correct} of ${r.total} right`),
        h('p', { class: 'muted' }, r.passed ? (r.streakGrew ? `🔥 ${r.streak}-day learning streak!` : `${r.passedCount} of ${r.totalLessons} lessons passed`) : `You need ${Math.ceil((2 * r.total) / 3)} right to pass. Read the answers below and give it another go.`),
        r.newBadges.length ? h('div', { class: 'cluster', style: { justifyContent: 'center', marginTop: '10px' } }, r.newBadges.map((b) => pill(`${b.emoji} ${b.title}`, 'primary'))) : null),
      h('section', null,
        h('div', { class: 'section-head' }, h('h2', null, 'How you did')),
        h('div', { class: 'card card-flush' }, lesson.questions.map((q, i) => reviewRow(q, i, submitted[i], r.results[i])))),
      h('div', { class: 'cluster' },
        !r.passed ? h('button', { class: 'btn btn-accent btn-lg', onClick: () => { answers = []; qi = 0; quiz(); } }, icon('undo', 18), 'Try again') : null,
        upNext && r.passed ? h('a', { class: 'btn btn-accent btn-lg', href: `#/learn/${upNext.key}` }, `Next: ${upNext.title}`, icon('right', 18)) : null,
        h('button', { class: 'btn btn-lg', onClick: () => { answers = []; qi = 0; read(); } }, 'Read it again'),
        h('a', { class: 'btn btn-ghost btn-lg', href: '#/learn' }, 'All lessons')),
    );
    focusTitle();
    window.scrollTo(0, 0);
  }

  read();
  return root;
}

function reviewRow(q, i, mine, res) {
  return h('div', { class: 'row review-row' },
    h('div', { class: `row-icon ${res.correct ? 'pos' : 'neg'}`, 'aria-hidden': 'true' }, icon(res.correct ? 'check' : 'x', 20)),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, q.q),
      h('div', { class: 'row-sub' }, res.correct ? `Your answer: ${q.options[mine]}` : [`You said: ${q.options[mine]}`, h('br'), h('b', null, `Right answer: ${q.options[res.answer]}`)]),
      h('div', { class: 'row-sub', style: { marginTop: '4px' } }, res.why),
      h('span', { class: 'sr-only' }, res.correct ? 'Correct' : 'Incorrect')));
}
