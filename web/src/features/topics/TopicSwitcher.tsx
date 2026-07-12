import { useEffect, useMemo, useState } from 'react';
import type { TopicDirectoryRow, ActiveTopicFilter } from './topicFilters.js';
import { UNASSIGNED_TOPIC_VALUE } from './topicFilters.js';

const STARRED_TOPICS_KEY = 'knowledge-e3.starredTopics.v1';
const RECENT_TOPICS_KEY = 'knowledge-e3.recentTopics.v1';

function readStoredList(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredList(key: string, values: string[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(values));
}

interface TopicSwitcherProps {
  activeTopic: ActiveTopicFilter;
  topics: TopicDirectoryRow[];
  onSelectTopic: (value?: string) => void;
}

export function TopicSwitcher({ activeTopic, topics, onSelectTopic }: TopicSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [starredTopics, setStarredTopics] = useState<string[]>(() => readStoredList(STARRED_TOPICS_KEY));
  const [recentTopics, setRecentTopics] = useState<string[]>(() => readStoredList(RECENT_TOPICS_KEY));

  useEffect(() => {
    writeStoredList(STARRED_TOPICS_KEY, starredTopics);
  }, [starredTopics]);

  useEffect(() => {
    writeStoredList(RECENT_TOPICS_KEY, recentTopics);
  }, [recentTopics]);

  const filteredTopics = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return topics;
    return topics.filter((topic) => {
      return topic.label.toLowerCase().includes(needle)
        || topic.slug.toLowerCase().includes(needle)
        || (topic.description?.toLowerCase().includes(needle) ?? false);
    });
  }, [query, topics]);

  const selectTopic = (value?: string) => {
    if (value) {
      setRecentTopics((current) => [value, ...current.filter((item) => item !== value)].slice(0, 5));
    }
    onSelectTopic(value);
    setIsOpen(false);
    setQuery('');
  };

  const toggleStar = (value: string) => {
    setStarredTopics((current) => current.includes(value) ? current.filter((item) => item !== value) : [value, ...current]);
  };

  const renderTopicButton = (topic: TopicDirectoryRow, context: string) => {
    const isActive = activeTopic.value === topic.value;
    const isStarred = starredTopics.includes(topic.value);
    return (
      <div className="TopicSwitcher__Row" key={`${context}-${topic.value}`}>
        <button
          type="button"
          className={`TopicSwitcher__TopicButton ${isActive ? 'active' : ''}`}
          onClick={() => selectTopic(topic.value)}
          aria-pressed={isActive}
        >
          <span className="TopicSwitcher__TopicMain">
            <span className="TopicSwitcher__TopicName">{topic.label}</span>
            <span className="TopicSwitcher__TopicDescription">{topic.description || (topic.kind === 'unassigned' ? 'Items without a space yet' : topic.slug)}</span>
          </span>
          <span className="TopicSwitcher__Count">{topic.count} item{topic.count === 1 ? '' : 's'}</span>
        </button>
        {topic.value !== UNASSIGNED_TOPIC_VALUE ? (
          <button
            type="button"
            className={`TopicSwitcher__Star ${isStarred ? 'active' : ''}`}
            onClick={() => toggleStar(topic.value)}
            aria-label={`${isStarred ? 'Unstar' : 'Star'} ${topic.label}`}
            aria-pressed={isStarred}
            title={`${isStarred ? 'Unstar' : 'Star'} ${topic.label}`}
          >
            ★
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="TopicSwitcher">
      <button
        type="button"
        className="TopicSwitcher__Chip"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <span>Space:</span>
        <strong>{activeTopic.label}</strong>
      </button>

      {isOpen ? (
        <div className="TopicSwitcher__Backdrop" role="presentation" onMouseDown={() => setIsOpen(false)}>
          <section
            className="TopicSwitcher__Drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topic-switcher-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="TopicSwitcher__Header">
              <div>
                <h2 id="topic-switcher-title">Space directory</h2>
                <p>Search, star, and switch spaces without losing your other browse filters.</p>
              </div>
              <button type="button" className="TopicSwitcher__Close" onClick={() => setIsOpen(false)} aria-label="Close space directory">
                ×
              </button>
            </div>

            <label className="TopicSwitcher__Search">
              <span>Search spaces</span>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search spaces…"
              />
            </label>

            <div className="TopicSwitcher__Section">
              <h3>{query ? 'Matching spaces' : 'All spaces'}</h3>
              {filteredTopics.length > 0 ? filteredTopics.map((topic) => renderTopicButton(topic, 'all')) : (
                <div className="TopicSwitcher__Empty">No spaces match “{query}”.</div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
