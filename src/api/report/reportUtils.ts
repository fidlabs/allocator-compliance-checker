import dayjs from 'dayjs';
import { emojify } from 'node-emoji';
import xbytes from 'xbytes';

import { ClientsByVerifier, GrantedDatacapInClients } from './reportModel';

export const reportUtils = {
  distinctSizesOfAllocations: (
    grantedDatacapInClients: GrantedDatacapInClients[],
    auditTrails: { [key: string]: string }
  ) => {
    const groupedByAddressId = groupByAddressId(grantedDatacapInClients);
    const groupsSortedByTimestamp = sortGroupsByTimestamp(groupedByAddressId);
    return createContent(groupsSortedByTimestamp, auditTrails);
  },
  datacapInClients: (grantedDatacapInClients: GrantedDatacapInClients[]) => {
    const groupedByAddressId = groupByAddressId(grantedDatacapInClients);
    const groupsSortedByTimestamp = sortGroupsByTimestamp(groupedByAddressId);
    return groupsSortedByTimestamp;
  },
  randomizeColor: () => {
    const base = 128;
    const range = 127;
    const r = (base + Math.abs(Math.sin(Math.random() + 1) * range)) | 0;
    const g = (base + Math.abs(Math.sin(Math.random() + 2) * range)) | 0;
    const b = (base + Math.abs(Math.sin(Math.random() + 3) * range)) | 0;
    return `rgba(${r}, ${g}, ${b})`;
  },
};

export const formattedTimeDiff = (from: dayjs.Dayjs, to: dayjs.Dayjs): string => {
  const hours = to.diff(from, 'hours');
  if (hours >= 48) {
    return `${to.diff(from, 'days')} days`;
  }

  return `${hours} hours`;
};

export const generateClientsRow = async (
  e: ClientsByVerifier,
  flaggedClientsInfo: any[],
  reportRepository: any,
  auditTrails: { [key: string]: string }
) => {
  const totalAllocations = e.allowanceArray.reduce((acc: number, curr: any) => acc + Number(curr.allowance), 0);
  const warning = flaggedClientsInfo.find((flaggedClient) => flaggedClient.addressId === e.addressId)
    ? emojify(':warning:')
    : '';
  const linkToInteractions = `https://filecoinpulse.pages.dev/client/${e.addressId}/#client-interactions-with-storage-providers`;

  const cidReportUrl = await reportRepository.getClientCidReportUrl(e.address);

  const userId = auditTrails[e.addressId] ? `[${e.addressId}](${auditTrails[e.addressId]})` : e.addressId;
  return `| ${warning} ${userId} | ${e.name || '-'} | ${e.allowanceArray.length} | ${xbytes(totalAllocations, { iec: true })} | [Filecoin Pulse](${linkToInteractions}) | ${cidReportUrl} |`;
};

const groupByAddressId = (grantedDatacapInClients: GrantedDatacapInClients[]) =>
  grantedDatacapInClients.reduce(
    (groups: Record<string, { allocation: number; allocationTimestamp: number }[]>, allocation) => {
      const key = allocation.addressId;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push({
        allocation: allocation.allocation,
        allocationTimestamp: allocation.allocationTimestamp,
      });
      return groups;
    },
    {}
  );

const sortGroupsByTimestamp = (
  groupedByAddressId: Record<string, { allocation: number; allocationTimestamp: number }[]>
) =>
  Object.entries(groupedByAddressId).map(([addressId, allocations]) => ({
    addressId,
    allocations: allocations.sort((a, b) => a.allocationTimestamp - b.allocationTimestamp),
  }));

const createContent = (
  groupsSortedByTimestamp: {
    addressId: string;
    allocations: { allocation: number; allocationTimestamp: number }[];
  }[],
  auditTrails: { [key: string]: string }
) => {
  const content = [];
  content.push(
    'The table below shows the allocations for each client. The percentage next to each allocation represents the increase or decrease compared to the previous allocation.'
  );
  content.push('');
  content.push('| ID | First Allocation | Second Allocation | Third Allocation | Remaining Allocations |');
  content.push('|-|-|-|-|-|');

  groupsSortedByTimestamp.map(({ addressId, allocations }) => {
    const allocationWithPercentage = allocations.map((allocation, index) => {
      if (index === 0) {
        return xbytes(Number(allocation.allocation), { iec: true });
      }
      const previousAllocation = Number(allocations[index - 1].allocation);
      const currentAllocation = Number(allocation.allocation);
      const percentage = (currentAllocation / previousAllocation) * 100;
      return `${xbytes(currentAllocation, { iec: true })} (${percentage}%)`;
    });

    const remainingAllocations = allocations.slice(3);
    const remainingAlloc =
      remainingAllocations.map((allocation) => xbytes(Number(allocation.allocation), { iec: true })).join(', ') || '-';
    const userId = auditTrails[addressId] ? `[${addressId}](${auditTrails[addressId]})` : addressId;
    content.push(
      `|${userId}| ${allocationWithPercentage[0] || '-'} | ${allocationWithPercentage[1] || '-'} | ${allocationWithPercentage[2] || '-'} | ${remainingAlloc} |`
    );
  });
  content.push('');
  return content.join('\n');
};
