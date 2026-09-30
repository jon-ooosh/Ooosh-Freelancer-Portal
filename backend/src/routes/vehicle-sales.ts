/**
 * Vehicle sales — /api/vehicle-sales (docs/VEHICLE-SALES-SPEC.md, Phase 1).
 *
 * All rules live in services/vehicle-sales.ts (THE definition); this file only
 * maps HTTP to it. Staff-only throughout; the admin-only actions (start,
 * withdraw, price / VAT / hold date) are enforced by the service's
 * planSalePatch() and the start route below.
 */
import { Router, Response } from 'express';
import multer from 'multer';
import { authenticate, authorize, AuthRequest, STAFF_ROLES } from '../middleware/auth';
import { isR2Configured } from '../config/r2';
import {
  SaleError,
  getSale,
  getOpenSaleIdForVehicle,
  listOpenSales,
  startSale,
  updateSale,
  confirmPhotos,
  addEventPhotos,
  uploadSalePhoto,
  updateSalePhotoLabel,
  reorderSalePhotos,
  removeSalePhoto,
} from '../services/vehicle-sales';
import { refreshVehicleMot } from '../services/dvsa-mot';

const router = Router();
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof SaleError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`[vehicle-sales] ${what}:`, err);
  res.status(500).json({ error: `Failed to ${what}` });
}

/** 404 for a malformed id rather than a Postgres cast error (500). */
function idOr404(res: Response, raw: unknown, label = 'Sale'): string | null {
  const id = String(raw ?? '');
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: `${label} not found` });
    return null;
  }
  return id;
}

async function sendSale(res: Response, saleId: string, status = 200): Promise<void> {
  const view = await getSale(saleId);
  if (!view) {
    res.status(404).json({ error: 'Sale not found' });
    return;
  }
  res.status(status).json({ data: view });
}

/** GET /open — every open sale, for the "For sale" pills. */
router.get('/open', async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await listOpenSales() });
  } catch (err) {
    fail(res, err, 'load open sales');
  }
});

/** GET /by-vehicle/:vehicleId — the van's open sale, or null. */
router.get('/by-vehicle/:vehicleId', async (req: AuthRequest, res: Response) => {
  const vehicleId = idOr404(res, req.params.vehicleId, 'Vehicle');
  if (!vehicleId) return;
  try {
    const saleId = await getOpenSaleIdForVehicle(vehicleId);
    res.json({ data: saleId ? await getSale(saleId) : null });
  } catch (err) {
    fail(res, err, 'load sale');
  }
});

/**
 * POST / — start a sale (admin). Also fetches the van's MOT history from DVSA
 * in the background, so the pack has it; a DVSA failure never blocks the start.
 */
router.post('/', authorize('admin'), async (req: AuthRequest, res: Response) => {
  const vehicleId = idOr404(res, req.body?.vehicleId, 'Vehicle');
  if (!vehicleId) return;
  try {
    const saleId = await startSale(vehicleId, req.user!.id, {
      askingPrice: req.body?.askingPrice,
      vatBasis: req.body?.vatBasis,
      holdFromHire: req.body?.holdFromHire,
    });
    void refreshVehicleMot(vehicleId, req.user!.id).catch(() => { /* recorded on the MOT row */ });
    await sendSale(res, saleId, 201);
  } catch (err) {
    fail(res, err, 'start sale');
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  const id = idOr404(res, req.params.id);
  if (!id) return;
  try {
    await sendSale(res, id);
  } catch (err) {
    fail(res, err, 'load sale');
  }
});

/** PATCH /:id — stage, description (staff); price, VAT, hold date, withdraw (admin). */
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const id = idOr404(res, req.params.id);
  if (!id) return;
  try {
    await updateSale(id, req.user!.role, req.body ?? {});
    await sendSale(res, id);
  } catch (err) {
    fail(res, err, 'update sale');
  }
});

// ── Photos ────────────────────────────────────────────────────────────────

/** POST /:id/photos — add book-out / check-in photos of this van by key. */
router.post('/:id/photos', async (req: AuthRequest, res: Response) => {
  const id = idOr404(res, req.params.id);
  if (!id) return;
  try {
    const photos = Array.isArray(req.body?.photos) ? req.body.photos : [];
    await addEventPhotos(id, req.user!.id, photos);
    await sendSale(res, id);
  } catch (err) {
    fail(res, err, 'add photos');
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG or WebP photos'));
  },
});

/** POST /:id/photos/upload — a new photo taken for the sale (multipart `file`, optional `label`). */
router.post('/:id/photos/upload', (req: AuthRequest, res: Response) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      res.status(400).json({ error: (uploadErr as Error).message || 'Upload failed' });
      return;
    }
    const id = idOr404(res, req.params.id);
    if (!id) return;
    if (!isR2Configured()) {
      res.status(503).json({ error: 'File storage not configured' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No photo provided' });
      return;
    }
    try {
      await uploadSalePhoto(id, req.user!.id, { buffer: req.file.buffer, mimetype: req.file.mimetype }, req.body?.label);
      await sendSale(res, id, 201);
    } catch (err) {
      fail(res, err, 'upload photo');
    }
  });
});

/** PUT /:id/photos/order — { ids: [...] } in display order. */
router.put('/:id/photos/order', async (req: AuthRequest, res: Response) => {
  const id = idOr404(res, req.params.id);
  if (!id) return;
  try {
    await reorderSalePhotos(id, req.body?.ids);
    await sendSale(res, id);
  } catch (err) {
    fail(res, err, 'reorder photos');
  }
});

/** POST /:id/photos/confirm — "Photos still OK". */
router.post('/:id/photos/confirm', async (req: AuthRequest, res: Response) => {
  const id = idOr404(res, req.params.id);
  if (!id) return;
  try {
    await confirmPhotos(id);
    await sendSale(res, id);
  } catch (err) {
    fail(res, err, 'confirm photos');
  }
});

router.patch('/:id/photos/:photoId', async (req: AuthRequest, res: Response) => {
  const id = idOr404(res, req.params.id);
  if (!id) return;
  const photoId = idOr404(res, req.params.photoId, 'Photo');
  if (!photoId) return;
  try {
    await updateSalePhotoLabel(id, photoId, req.body?.label);
    await sendSale(res, id);
  } catch (err) {
    fail(res, err, 'update photo');
  }
});

router.delete('/:id/photos/:photoId', async (req: AuthRequest, res: Response) => {
  const id = idOr404(res, req.params.id);
  if (!id) return;
  const photoId = idOr404(res, req.params.photoId, 'Photo');
  if (!photoId) return;
  try {
    await removeSalePhoto(id, photoId);
    await sendSale(res, id);
  } catch (err) {
    fail(res, err, 'remove photo');
  }
});

export default router;
