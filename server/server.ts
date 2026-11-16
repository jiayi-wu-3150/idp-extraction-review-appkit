import { createApp, analytics, files, server } from '@databricks/appkit';
import { setupReviewRoutes } from './routes/review-routes';

createApp({
  plugins: [
    /*
      Caching off, deliberately. The analytics plugin caches every query result
      for an hour by default (`queryDefaults.cache = {enabled: true, ttl: 3600}`),
      keyed by query key + parameters + SQL hash. In a review queue that is a
      correctness bug, not an optimisation: a document stays in the queue after
      it has been approved, and reviewers cannot see each other's work for an
      hour. These three queries are small, so paying the warehouse round trip
      on each load is the right trade. Raise `ttl` instead of disabling if a
      large corpus makes the queue query expensive.
    */
    analytics({ cache: { enabled: false } }),
    files(),
    server(),
  ],
  // The three read queries are served by the analytics plugin straight from
  // `config/queries`. Only the write needs a route of its own, so that the
  // reviewer identity comes from the request headers and not the client.
  async onPluginsReady(appkit) {
    setupReviewRoutes(appkit as unknown as Parameters<typeof setupReviewRoutes>[0]);
  },
}).catch(console.error);
