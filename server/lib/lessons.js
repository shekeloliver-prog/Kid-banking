// "Money Smarts": short lessons with a three-question quiz. They teach habits (needs vs. wants, saving, giving,
// staying safe) and never touch anyone's balance. Scoring happens here, so the right answers are only revealed
// after an attempt; a kid can retry as often as they like (a little less than a dozen times a day).

import { HttpError } from './util.js';
import { dateInZone, addDays } from './dates.js';

export const PASS_RATIO = 2 / 3;
const MAX_ATTEMPTS_PER_LESSON_PER_DAY = 12;

export const LESSONS = [
  {
    key: 'needs-wants',
    emoji: '🍎',
    title: 'Needs vs. wants',
    blurb: 'What you must have, and what is just nice to have.',
    minutes: 2,
    learn: [
      'A need is something you must have to be safe and healthy, like food, a place to live, and warm clothes.',
      'A want is something that would be fun or nice, like a new game or the fanciest sneakers.',
      'Smart spenders cover their needs first. Wants are great too, as long as there is room for them.',
    ],
    questions: [
      { q: 'Which one is a NEED?', options: ['A video game', 'Dinner tonight', 'A toy robot'], answer: 1, why: 'Food keeps you healthy. Games and toys are wants.' },
      { q: 'You want a new toy, but your shoes have a hole in them. What should come first?', options: ['The toy', 'The shoes', 'Neither, ever'], answer: 1, why: 'Shoes you can wear are a need. The toy can wait.' },
      { q: 'Wants are…', options: ['Always bad', 'Fine, once needs are covered', 'The same as needs'], answer: 1, why: 'Wants make life fun. Just take care of needs first.' },
    ],
  },
  {
    key: 'why-save',
    emoji: '🐷',
    title: 'Why we save',
    blurb: 'Keep some for later so you are ready for surprises.',
    minutes: 2,
    learn: [
      'Saving means keeping some of your money instead of spending all of it right away.',
      'Savings help you buy bigger things that cost more than one allowance, and they help when something unexpected comes up.',
      'A good habit: set aside a little every time you get money, even if it is small.',
    ],
    questions: [
      { q: 'What does saving mean?', options: ['Spending it all today', 'Keeping some for later', 'Giving it all away'], answer: 1, why: 'Saving is keeping money for later.' },
      { q: 'You get your allowance. Which is the best saving habit?', options: ['Set a little aside each time', 'Wait until you have lots', 'Spend it before it is gone'], answer: 0, why: 'Small amounts add up when you do it every time.' },
      { q: 'Why do people keep emergency savings?', options: ['For surprises', 'To look rich', 'Because spending is forbidden'], answer: 0, why: 'Surprises happen, and savings help you handle them.' },
    ],
  },
  {
    key: 'goals',
    emoji: '🎯',
    title: 'Setting a goal',
    blurb: 'Pick something you want and make a plan to get there.',
    minutes: 3,
    learn: [
      'A savings goal is something specific you are saving up for, like a bike or a game.',
      'Write down the price, then work out how much you need to put away each week.',
      'Seeing your progress fill up keeps you going. Celebrate when you get there!',
    ],
    questions: [
      { q: 'Which is the best goal?', options: ['“Get stuff”', '“A $60 scooter by summer”', '“Be rich”'], answer: 1, why: 'A goal with a price and a time is easy to plan for.' },
      { q: 'A skateboard costs $40 and you can save $5 a week. How many weeks will it take?', options: ['4 weeks', '8 weeks', '10 weeks'], answer: 1, why: '$40 ÷ $5 = 8 weeks.' },
      { q: 'What helps you stick with a goal?', options: ['Hiding the plan', 'Watching your progress', 'Changing the goal every day'], answer: 1, why: 'Seeing progress keeps you motivated.' },
    ],
  },
  {
    key: 'smart-spend',
    emoji: '🛍️',
    title: 'Spend smart',
    blurb: 'Compare, wait a day, and get the most for your money.',
    minutes: 3,
    learn: [
      'Before you buy, ask: do I really want this, and will I still want it tomorrow?',
      'Compare prices. The same thing can cost different amounts in different places.',
      'Once you spend money it is gone, so spending on something you truly enjoy beats lots of little impulse buys.',
    ],
    questions: [
      { q: 'You see something shiny and want it right now. What is a smart move?', options: ['Buy it immediately', 'Wait a day and decide', 'Borrow from a friend'], answer: 1, why: 'Waiting a day shows whether you still want it.' },
      { q: 'Two stores sell the same notebook. One costs $3 and the other $5. Which is the better deal?', options: ['The $5 one', 'The $3 one', 'It does not matter'], answer: 1, why: 'Same notebook, lower price: you keep $2.' },
      { q: 'An impulse buy is…', options: ['A planned purchase', 'Something you buy suddenly without thinking', 'A sale item'], answer: 1, why: 'Impulse means you did not plan it.' },
    ],
  },
  {
    key: 'earning',
    emoji: '🧹',
    title: 'Earning money',
    blurb: 'Money comes from work, effort and good ideas.',
    minutes: 2,
    learn: [
      'People earn money by working: they help others, make things, or solve problems.',
      'At home, chores are practice at doing a job well and finishing what you promised.',
      'Money you earn feels different from money you are given, and it is worth looking after.',
    ],
    questions: [
      { q: 'How do grown-ups mostly get money?', options: ['They find it', 'They work at a job', 'They wish for it'], answer: 1, why: 'Most people earn money by working.' },
      { q: 'Why is doing a chore a good practice for a job?', options: ['You learn to finish what you promised', 'You get out of homework', 'Nobody checks it'], answer: 0, why: 'Reliability is the biggest part of any job.' },
      { q: 'Which is a way a kid could earn money?', options: ['Walking a neighbor’s dog (with permission)', 'Taking things that are not theirs', 'Waiting for it to appear'], answer: 0, why: 'Helping others, safely and with a grown-up’s okay, is real work.' },
    ],
  },
  {
    key: 'giving',
    emoji: '🎁',
    title: 'Sharing & giving',
    blurb: 'Money can help other people too.',
    minutes: 2,
    learn: [
      'Giving means sharing some of what you have to help someone else or a cause you care about.',
      'You do not need much to give. A little can make a real difference, and so can your time.',
      'Many families set aside a small share for giving, just like a share for saving.',
    ],
    questions: [
      { q: 'Which is a way to give?', options: ['Donating to an animal shelter', 'Hiding your money', 'Buying more for yourself'], answer: 0, why: 'Helping a cause you care about is giving.' },
      { q: 'You only have a little money. Can you still give?', options: ['No, you need a lot', 'Yes, a little still helps', 'Only on birthdays'], answer: 1, why: 'Small gifts matter, and so does your time.' },
      { q: 'Besides money, what else can you give?', options: ['Your time and help', 'Nothing else', 'Only things you bought'], answer: 0, why: 'Helping out is a gift too.' },
    ],
  },
  {
    key: 'safe',
    emoji: '🔐',
    title: 'Keeping money safe',
    blurb: 'Protect your PIN and say no to tricks.',
    minutes: 3,
    learn: [
      'Your PIN is a secret. Never share it with friends, and never type it where someone is watching.',
      'If an online message promises free money or asks for your password, it is a trick. Show a grown-up.',
      'Tell a parent right away if something looks wrong. Checking your activity often helps you spot mistakes.',
    ],
    questions: [
      { q: 'A friend asks for your PIN so they can “check” your account. What do you do?', options: ['Tell them', 'Keep it secret', 'Write it on your hand'], answer: 1, why: 'A PIN is private, even from friends.' },
      { q: 'A pop-up says “You won $1,000! Type your password!” What is it?', options: ['A real prize', 'A trick', 'A school notice'], answer: 1, why: 'Free-money messages are tricks. Show a grown-up.' },
      { q: 'You notice a purchase you do not remember. What now?', options: ['Ignore it', 'Tell a parent', 'Delete the app'], answer: 1, why: 'Telling a parent helps sort it out fast.' },
    ],
  },
  {
    key: 'planning',
    emoji: '🗺️',
    title: 'Plan before you spend',
    blurb: 'A simple plan makes your money go further.',
    minutes: 3,
    learn: [
      'A budget is just a plan for your money: some to spend, some to save, some to give.',
      'Try splitting what you get into parts as soon as it arrives, before it disappears.',
      'Check in on your plan now and then. If something changes, change your plan.',
    ],
    questions: [
      { q: 'What is a budget?', options: ['A plan for your money', 'A kind of bank', 'A prize'], answer: 0, why: 'A budget is simply a plan.' },
      { q: 'When is the best time to decide how to split your money?', options: ['When it arrives', 'After it is spent', 'Never'], answer: 0, why: 'Planning first keeps you in control.' },
      { q: 'You planned to spend $10 but you have only $6 left. What is a smart choice?', options: ['Spend $10 anyway', 'Change the plan to fit $6', 'Pretend you have more'], answer: 1, why: 'Adjust the plan to fit what you really have.' },
    ],
  },
];

const BY_KEY = new Map(LESSONS.map((l) => [l.key, l]));

/** Number of consecutive days, ending today (or yesterday, so a streak survives until the day is over). */
export function streakOf(days, today) {
  const have = new Set(days);
  let day = have.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (have.has(day)) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

export function createLessons(core) {
  const { q, atomic, getUser, parentZone, clock } = core;

  const notFound = () => new HttpError(404, 'not_found', "That lesson wasn't found.");
  const zoneToday = async (kidId) => {
    const kid = await getUser(kidId);
    return dateInZone(clock(), await parentZone(kid));
  };

  /** Days (kid's calendar, parent's time zone) on which a lesson was passed, newest first. */
  const passedDays = async (kidId) => (await q('SELECT DISTINCT day FROM lesson_attempts WHERE kid_id = ? AND passed = 1 ORDER BY day DESC LIMIT 400').all(kidId)).map((r) => r.day);

  async function streakFor(kidId) {
    const today = await zoneToday(kidId);
    return streakOf(await passedDays(kidId), today);
  }

  async function lessonsFor(kidId) {
    const today = await zoneToday(kidId);
    const [best, days] = await Promise.all([
      q(
        `SELECT lesson_key, MAX(correct) AS best, MAX(total) AS total, MAX(passed) AS passed, COUNT(*) AS attempts
         FROM lesson_attempts WHERE kid_id = ? GROUP BY lesson_key`,
      ).all(kidId),
      passedDays(kidId),
    ]);
    const by = new Map(best.map((r) => [r.lesson_key, r]));
    const lessons = LESSONS.map((l) => {
      const r = by.get(l.key);
      return {
        key: l.key,
        emoji: l.emoji,
        title: l.title,
        blurb: l.blurb,
        minutes: l.minutes,
        questions: l.questions.length,
        passed: !!r?.passed,
        bestCorrect: r?.best ?? null,
        attempts: r?.attempts ?? 0,
      };
    });
    return {
      lessons,
      passedCount: lessons.filter((l) => l.passed).length,
      total: lessons.length,
      streak: streakOf(days, today),
      doneToday: days[0] === today,
    };
  }

  /** The lesson as the kid should see it before answering — no answers. */
  function lessonDetail(key) {
    const l = BY_KEY.get(key);
    if (!l) throw notFound();
    return {
      key: l.key,
      emoji: l.emoji,
      title: l.title,
      minutes: l.minutes,
      learn: l.learn,
      questions: l.questions.map((x) => ({ q: x.q, options: x.options })),
      passMark: Math.ceil(l.questions.length * PASS_RATIO),
    };
  }

  async function submitLesson(kidId, key, answers) {
    const l = BY_KEY.get(key);
    if (!l) throw notFound();
    if (!Array.isArray(answers) || answers.length !== l.questions.length || !answers.every((a, i) => Number.isInteger(a) && a >= 0 && a < l.questions[i].options.length)) {
      throw new HttpError(400, 'invalid', 'Answer every question first.');
    }
    return atomic(async () => {
      const kid = await getUser(kidId);
      const today = dateInZone(clock(), await parentZone(kid));
      const tries = (await q('SELECT COUNT(*) AS n FROM lesson_attempts WHERE kid_id = ? AND lesson_key = ? AND day = ?').get(kidId, key, today)).n;
      if (tries >= MAX_ATTEMPTS_PER_LESSON_PER_DAY) {
        throw new HttpError(429, 'enough_for_today', 'That is plenty of tries for today. Come back tomorrow!');
      }
      const results = l.questions.map((x, i) => ({ correct: answers[i] === x.answer, answer: x.answer, why: x.why }));
      const correct = results.filter((r) => r.correct).length;
      const total = results.length;
      const passed = correct / total >= PASS_RATIO;
      const beforeStreak = streakOf(await passedDays(kidId), today);
      await q('INSERT INTO lesson_attempts (kid_id, lesson_key, correct, total, passed, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        kidId,
        key,
        correct,
        total,
        passed ? 1 : 0,
        today,
        clock().toISOString(),
      );
      const newBadges = await core.badges.awardBadges(kidId);
      const progress = await lessonsFor(kidId);
      return { correct, total, passed, results, streak: progress.streak, streakGrew: progress.streak > beforeStreak, passedCount: progress.passedCount, totalLessons: progress.total, newBadges };
    });
  }

  return { lessonsFor, lessonDetail, submitLesson, streakFor };
}
