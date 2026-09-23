import { vi, beforeEach, describe, it, expect } from 'vitest';

vi.mock('../db/poolManager.js', () => ({
  getClient: vi.fn(),
  getSystemClient: vi.fn(),
}));
vi.mock('../config/logging.js', () => ({ log: vi.fn() }));

import * as poolManagerNamed from '../db/poolManager.js';
import foodRepository from '../models/food.js';

const UID = 'user-1';

interface QueryCall {
  sql: string;
  params: unknown[];
}

/**
 * Drives createFoodsInBulk through the overwrite path for one food that already
 * exists with one matching variant, and returns every query it issued.
 */
async function runOverwriteImport(
  variant: Record<string, unknown>
): Promise<QueryCall[]> {
  const calls: QueryCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id, name, brand FROM foods')) {
        return { rows: [{ id: 'food-1', name: 'Oats', brand: 'Acme' }] };
      }
      if (sql.includes('SELECT id FROM food_variants')) {
        return { rows: [{ id: 'variant-1' }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  (poolManagerNamed.getClient as ReturnType<typeof vi.fn>).mockResolvedValue(
    client
  );
  await foodRepository.createFoodsInBulk(
    UID,
    [{ name: 'Oats', brand: 'Acme', ...variant }] as never,
    true
  );
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createFoodsInBulk — health score inputs', () => {
  async function runCreateImport(
    rows: Record<string, unknown>[]
  ): Promise<QueryCall[]> {
    const calls: QueryCall[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('INSERT INTO foods')) {
          return { rows: [{ id: 'food-new' }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    (poolManagerNamed.getClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      client
    );
    await foodRepository.createFoodsInBulk(
      UID,
      rows.map((row) => ({ name: 'Cola', brand: 'Fizz', ...row })) as never,
      false
    );
    return calls;
  }

  function foodInsert(calls: QueryCall[]): QueryCall {
    const call = calls.find((c) => c.sql.includes('INSERT INTO foods'));
    if (!call) throw new Error('no foods INSERT was issued');
    return call;
  }

  it('stores the values a row carries', async () => {
    const insert = foodInsert(
      await runCreateImport([
        {
          serving_size: 100,
          serving_unit: 'ml',
          added_sugars: '10.6',
          fruit_veg_legume_percent: 0,
        },
      ])
    );
    expect(insert.sql).toContain('added_sugars, fruit_veg_legume_percent');
    expect(insert.params.slice(11, 13)).toEqual([10.6, 0]);
  });

  it('stores null for a missing or blank column', async () => {
    const insert = foodInsert(
      await runCreateImport([
        { serving_size: 100, serving_unit: 'ml', added_sugars: '' },
      ])
    );
    expect(insert.params.slice(11, 13)).toEqual([null, null]);
  });

  it('takes the first stated value across a food’s variant rows', async () => {
    const insert = foodInsert(
      await runCreateImport([
        { serving_size: 100, serving_unit: 'ml', is_default: true },
        { serving_size: 350, serving_unit: 'ml', added_sugars: 10.6 },
      ])
    );
    expect(insert.params[11]).toBe(10.6);
  });

  it('rejects an out-of-range percentage before touching the database', async () => {
    await expect(
      runCreateImport([
        {
          serving_size: 100,
          serving_unit: 'g',
          fruit_veg_legume_percent: 120,
        },
      ])
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(poolManagerNamed.getClient).not.toHaveBeenCalled();
  });

  it('keeps stored values on overwrite when the import omits them', async () => {
    const calls = await runOverwriteImport({
      serving_size: 100,
      serving_unit: 'g',
      calories: 250,
    });
    const update = calls.find((c) => c.sql.includes('UPDATE foods SET'));
    expect(update?.sql).toContain('added_sugars = COALESCE($6, added_sugars)');
    expect(update?.params.slice(5, 7)).toEqual([null, null]);
  });
});
