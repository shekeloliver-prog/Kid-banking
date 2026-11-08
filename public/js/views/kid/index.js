import { kidHome } from './home.js';
import { goalsView } from './goals.js';
import { kidActivityView } from './activity.js';
import { askView } from './ask.js';
import { kidChoresView } from './chores.js';
import { learnView, lessonView } from './learn.js';

export const kidRoutes = [
  ['/', kidHome],
  ['/goals', goalsView],
  ['/chores', kidChoresView],
  ['/learn', learnView],
  ['/learn/:key', lessonView],
  ['/activity', kidActivityView],
  ['/ask', askView],
];
