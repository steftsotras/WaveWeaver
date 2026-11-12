import type { PageServerLoad } from './$types';
import { setupStatus } from '$lib/server/setup';

export const load: PageServerLoad = async () => ({ status: await setupStatus() });
