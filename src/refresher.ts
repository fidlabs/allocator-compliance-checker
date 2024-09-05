import axios from 'axios';

import { reportService } from './api/report/reportService';

type Allocator = {
  owner: string;
  repo: string;
  multisig_address: string;
};

let refresh_in_progress = false;
async function refresh() {
  if (refresh_in_progress) return;

  refresh_in_progress = true;
  try {
    console.log('REFRESH: Periodic report refresh started.');
    console.log('REFRESH: Fetching allocators from api.allocator.tech');
    const response = await axios('https://api.allocator.tech/allocators');
    const allAllocators: Allocator[] = response.data;
    const validAllocators = allAllocators.filter((a) => a.multisig_address);

    console.log(`REFRESH: Running refresh for ${validAllocators.length} allocators`);
    for (const allocator of validAllocators) {
      const tag = `${allocator.owner}/${allocator.repo} - ${allocator.multisig_address}`;
      console.log(`REFRESH: ${tag} - Triggering refresh`);
      const res = await reportService.generateReport(allocator.multisig_address);
      console.log(`REFRESH: ${tag} - Finished - Success: ${res.success}; Code: ${res.statusCode}; Msg: ${res.message}`);
    }

    console.log(`REFRESH: Finished refresh for all ${validAllocators.length} allocators`);
  } catch (err) {
    console.error(err);
  } finally {
    refresh_in_progress = false;
  }
}

refresh();
