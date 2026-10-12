import { homeView, kidsView } from './home.js';
import { kidView } from './kid.js';
import { requestsView } from './requests.js';
import { activityView } from './activity.js';
import { fundingView } from './funding.js';
import { settingsView } from './settings.js';

export const parentRoutes = [
  ['/', homeView],
  ['/kids', kidsView],
  ['/kids/:id', kidView],
  ['/requests', requestsView],
  ['/activity', activityView],
  ['/funding', fundingView],
  ['/settings', settingsView],
];
