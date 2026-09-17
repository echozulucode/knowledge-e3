/**
 * LatestFeed — `/latest`: the site-wide chronological feed of published items
 * the viewer may read (plan §3.3), with its Atom link.
 */
import { Icon, appIcons } from '../../icons.js';
import { FeedList } from './FeedList.js';
import './Feed.css';

export function LatestFeed() {
  return (
    <main className="Feed" aria-labelledby="feed-latestfeed-title">
      <header className="Feed__header">
        <div>
          <h1 id="feed-latestfeed-title">Latest</h1>
          <p className="Feed__lead">New and updated items across every topic you can read, newest first.</p>
        </div>
        <a className="Feed__atom" href="/api/v1/feeds/latest.atom" target="_blank" rel="noreferrer">
          <Icon icon={appIcons.boltLightning} fixedWidth={false} /> Atom feed
        </a>
      </header>
      <FeedList params={{}} />
    </main>
  );
}
