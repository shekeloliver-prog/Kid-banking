import { homeView, kidsView } from './home.js';
import { kidView } from './kid.js';
import { requestsView } from './requests.js';
import { activityView } from './activity.js';
import { fundingView } from './funding.js';
import { settingsView } from './settings.js';
import { choresView } from './chores.js';
import { insightsView } from './insights.js';
import { moreView } from './more.js';

export const parentRoutes = [
  ['/', homeView],
  ['/kids', kidsView],
  ['/kids/:id', kidView],
  ['/chores', choresView],
  ['/requests', requestsView],
  ['/activity', activityView],
  ['/insights', insightsView],
  ['/more', moreView],
  ['/funding', fundingView],
  ['/settings', settingsView],
];
