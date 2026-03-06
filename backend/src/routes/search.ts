import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/search?q=searchterm&limit=20
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { q, limit = '20' } = req.query;
    if (!q || (q as string).trim().length < 2) {
      res.json({ results: [] });
      return;
    }

    const searchTerm = `%${(q as string).trim()}%`;
    const resultLimit = Math.min(parseInt(limit as string), 50);
    const perType = Math.ceil(resultLimit / 3);

    // Search people
    const peopleResults = await query(
      `SELECT id, first_name || ' ' || last_name as name, email as subtitle, 'person' as type
       FROM people
       WHERE is_deleted = false AND (
         first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR
         CONCAT(first_name, ' ', last_name) ILIKE $1 OR mobile ILIKE $1
       )
       ORDER BY last_name, first_name
       LIMIT $2`,
      [searchTerm, perType]
    );

    // Search organisations
    const orgResults = await query(
      `SELECT id, name, type as subtitle, 'organisation' as type
       FROM organisations
       WHERE is_deleted = false AND name ILIKE $1
       ORDER BY name
       LIMIT $2`,
      [searchTerm, perType]
    );

    // Search venues
    const venueResults = await query(
      `SELECT id, name, city as subtitle, 'venue' as type
       FROM venues
       WHERE is_deleted = false AND (name ILIKE $1 OR city ILIKE $1 OR address ILIKE $1 OR postcode ILIKE $1)
       ORDER BY name
       LIMIT $2`,
      [searchTerm, perType]
    );

    res.json({
      results: [
        ...peopleResults.rows,
        ...orgResults.rows,
        ...venueResults.rows,
      ],
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
