jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { query } from '../../config/database';
import { getGuidesFor, hasTopic, guidesAsPromptText, guidesUsedSummary } from '../house-knowledge';

const mockQuery = query as jest.Mock;

describe('house-knowledge', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns shared guides with their versions', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'd1', title: 'How we write to clients', ai_topics: ['voice'], version: 3, body: '  Short and plain.  ' }],
    });
    const result = await getGuidesFor(['voice', 'chasing']);
    expect(result.guides).toEqual([{ documentId: 'd1', title: 'How we write to clients', topics: ['voice'], version: 3, body: 'Short and plain.' }]);
    expect(result.overBudget).toBe(false);
    expect(hasTopic(result, 'voice')).toBe(true);
    expect(hasTopic(result, 'chasing')).toBe(false);
    expect(guidesAsPromptText(result)).toBe('=== How we write to clients (Ooosh guide, version 3) ===\nShort and plain.');
    expect(guidesUsedSummary(result)).toEqual([{ documentId: 'd1', title: 'How we write to clients', version: 3 }]);
    // Only approved, active, shared documents are read.
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/ai_shared = TRUE/);
    expect(sql).toMatch(/approval_status = 'approved'/);
    expect(sql).toMatch(/is_active = TRUE/);
    expect(sql).toMatch(/is_current = TRUE/);
  });

  it('never throws — a database error means no guides', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await getGuidesFor(['voice']);
    expect(result.guides).toEqual([]);
    expect(hasTopic(result, 'voice')).toBe(false);
  });

  it('flags guides over the budget but keeps them all', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'd1', title: 'Long', ai_topics: ['chasing'], version: 1, body: 'x'.repeat(31000) }],
    });
    const result = await getGuidesFor(['chasing']);
    expect(result.overBudget).toBe(true);
    expect(result.guides).toHaveLength(1);
  });
});
