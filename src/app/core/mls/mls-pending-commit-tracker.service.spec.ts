import { TestBed } from '@angular/core/testing';
import { MlsPendingCommitTracker } from './mls-pending-commit-tracker.service';

describe('MlsPendingCommitTracker', () => {
  let tracker: MlsPendingCommitTracker;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [MlsPendingCommitTracker] });
    tracker = TestBed.inject(MlsPendingCommitTracker);
  });

  it('returns undefined for a conversation with no tracked commit', () => {
    expect(tracker.get('conv-1')).toBeUndefined();
  });

  it('returns the promise registered via set for that conversation', () => {
    const p = Promise.resolve();
    tracker.set('conv-1', p);
    expect(tracker.get('conv-1')).toBe(p);
  });

  it('keeps per-conversation entries independent', () => {
    const p1 = Promise.resolve();
    const p2 = Promise.resolve();
    tracker.set('conv-1', p1);
    tracker.set('conv-2', p2);

    expect(tracker.get('conv-1')).toBe(p1);
    expect(tracker.get('conv-2')).toBe(p2);
  });

  it('overwrites a previous entry for the same conversation', () => {
    const p1 = Promise.resolve();
    const p2 = Promise.resolve();
    tracker.set('conv-1', p1);
    tracker.set('conv-1', p2);

    expect(tracker.get('conv-1')).toBe(p2);
  });

  it('delete removes only the targeted conversation entry', () => {
    tracker.set('conv-1', Promise.resolve());
    tracker.set('conv-2', Promise.resolve());

    tracker.delete('conv-1');

    expect(tracker.get('conv-1')).toBeUndefined();
    expect(tracker.get('conv-2')).toBeDefined();
  });

  it('clear removes every tracked conversation', () => {
    tracker.set('conv-1', Promise.resolve());
    tracker.set('conv-2', Promise.resolve());

    tracker.clear();

    expect(tracker.get('conv-1')).toBeUndefined();
    expect(tracker.get('conv-2')).toBeUndefined();
  });
});
