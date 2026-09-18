import { Router } from 'express';
import { getHealth } from '../controllers/health_controller';
import { optimizeEnergy } from '../controllers/optimize_controller';

const router = Router();

router.get('/health', getHealth);
router.post('/optimize-energy', optimizeEnergy);

export default router;
