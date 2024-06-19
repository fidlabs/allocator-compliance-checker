import axios from 'axios';
import { LegendOptions } from 'chart.js';
import dayjs from 'dayjs';
import fs from 'fs';
import { emojify } from 'node-emoji';
import path from 'path';

import { axiosConfig } from '@/common/utils/axiosConfig';
import { bytesToiB } from '@/common/utils/byteConverter';
import GenerateChart, { BarChartEntry } from '@/common/utils/charts/generateChart';
import { env } from '@/common/utils/envConfig';
import { heightToUnix } from '@/common/utils/filplusEpoch';
import { db } from '@/db';

import {
  ClientsByVerifier,
  ClientsByVerifierData,
  ClientsDeals,
  FlaggedClientsInfo,
  GetVerifiedClientsResponse,
  getVerifierClientsDataResponse,
  GetVerifiersDataItem,
  GetVerifiersResponse,
  GrantedDatacapByVerifier,
} from './reportModel';
import { reportUtils } from './reportUtils';

const LABELS = ['< 1', '1 - 12', '12 - 24', '24 - 48', '> 48'];

export const reportRepository = {
  generateReport: async (
    verifiersData: GetVerifiersDataItem,
    clientsData: ClientsByVerifierData,
    flaggedClientsInfo: FlaggedClientsInfo[],
    grantedDatacapByVerifier: GrantedDatacapByVerifier[],
    clientsDeals: ClientsDeals[]
  ): Promise<any> => {
    const content: string[] = [];
    content.push('# Compliance Report');
    const basepath = env.UPLOADS_DIR + '/' + verifiersData.addressId;
    if (Number(clientsData.count)) {
      const clientsRows = clientsData.data.map((e) => {
        const totalAllocations = e.allowanceArray.reduce((acc: number, curr: any) => acc + Number(curr.allowance), 0);
        const warning = flaggedClientsInfo.find((flaggedClient) => flaggedClient.addressId === e.addressId)
          ? emojify(':warning:')
          : '';
        return `| ${warning} ${e.addressId}| ${e.name} | ${e.allowanceArray.length} | ${bytesToiB(totalAllocations, false)} |`;
      });

      content.push('## Distribution of Datacap in Clients');
      content.push('');
      const getDatacapInClientsDist = reportUtils.datacapInClients(grantedDatacapByVerifier);
      const getDatacapInClientsChart = await reportRepository.getDatacapInClientsChart(
        getDatacapInClientsDist,
        clientsDeals
      );
      //generate histogram images based on clients allocation and deals made
      getDatacapInClientsChart.map((chart, idx) => {
        reportRepository.uploadFile(`${basepath}/datacap_in_clients/`, chart, `histogram_${idx}`, 'png');
      });

      //calculate distinct sizes of allocations table
      const distinctSizesOfAllocations = reportUtils.distinctSizesOfAllocations(grantedDatacapByVerifier);
      content.push(distinctSizesOfAllocations);

      // Generate bar chart image for clients datacap issuance
      const getBarChartImage = await reportRepository.getBarChartImage(grantedDatacapByVerifier);
      reportRepository.uploadFile(basepath, getBarChartImage, 'issuance_chart', 'png');

      content.push('## List of clients and their allocations');
      content.push('');
      content.push('| ID | Name | Number of Allocations | Total Allocations |');
      content.push('|-|-|-|-|');
      clientsRows.forEach((row: string) => content.push(row));
      content.push('');

      if (flaggedClientsInfo.length > 0) {
        content.push(`### Clients with ${emojify(':warning:')} flag received datacap from more than one verifier`);
        content.push('');
      }

      if (Number(clientsData.count) > env.VERIFIER_CLIENTS_QUERY_LIMIT)
        content.push(
          `## ${emojify(':warning:')} There are more than ${env.VERIFIER_CLIENTS_QUERY_LIMIT} clients for a given allocator, report may be inaccurate`
        );
    } else {
      content.push('### No Datacap issued for verifier');
    }
    const joinedContent = Buffer.from(content.join('\n')).toString('base64');
    reportRepository.uploadFile(basepath, joinedContent, 'report', 'md');
  },
  getVerifiersData: async (apiKey: string, verifierAddress: string): Promise<GetVerifiersDataItem> => {
    try {
      const {
        data: { data },
      }: GetVerifiersResponse = await axios.get(
        env.DATACAP_API_URL + '/getVerifiers',
        axiosConfig(apiKey, {
          page: 1,
          limit: 1,
          filter: verifierAddress,
        })
      );
      const verifiersData = data[0];
      if (!verifiersData) {
        throw new Error('Verifier not found');
      }
      return verifiersData;
    } catch (error) {
      throw new Error('Error getting verifier data from datacapstats.io API' + error);
    }
  },
  getClientsByVerifierId: async (apiKey: string, verifiersAddressId: string) => {
    try {
      const { data }: getVerifierClientsDataResponse = await axios.get(
        // Returns a list of verified clients that received datacap from a verifier.
        env.DATACAP_API_URL + `/getVerifiedClients/${verifiersAddressId}`,
        axiosConfig(apiKey, {
          page: 1,
          limit: env.VERIFIER_CLIENTS_QUERY_LIMIT || 20,
        })
      );

      const clientsData = {
        data: data.data.map((e) => ({
          ...e,
          allowanceArray: e.allowanceArray.map((a) => ({
            ...a,
            allowance: Number(a.allowance),
          })),
        })),
        count: data.count,
      };
      if (!clientsData.data) {
        throw new Error('Clients not found for verifier' + verifiersAddressId);
      }
      return clientsData;
    } catch (error) {
      throw new Error('Error getting verifier clients data from datacapstats.io API' + error);
    }
  },
  getClientsByClientId: async (id: string, apiKey: string): Promise<ClientsByVerifierData> => {
    try {
      const { data }: GetVerifiedClientsResponse = await axios.get(
        env.DATACAP_API_URL + `/getVerifiedClients`,
        axiosConfig(apiKey, { page: 1, limit: 2, filter: id })
      );

      return data;
    } catch (error) {
      throw new Error(`Error getting verified clients for id ${id}: ${error}`);
    }
  },
  getFlaggedClients: async (
    apiKey: string,
    VerifierClientsData: ClientsByVerifier[]
  ): Promise<FlaggedClientsInfo[]> => {
    const clientAddressIds = VerifierClientsData.map((e) => e.addressId);
    try {
      const responses: ClientsByVerifierData[] = await Promise.all(
        clientAddressIds.map((id: string) => reportRepository.getClientsByClientId(id, apiKey))
      );

      const flaggedClientsInfo = responses
        .filter(({ count }) => Number(count) > 1)
        .map(({ data }) => ({ addressId: data[0].addressId }));

      return flaggedClientsInfo;
    } catch (error) {
      throw new Error('Error getting flagged clients data from datacapstats.io API: ' + error);
    }
  },

  getGrantedDatacapByVerifier: (VerifierClientsData: ClientsByVerifier[]): GrantedDatacapByVerifier[] => {
    const ClientsData = VerifierClientsData.map((e) => ({
      addressId: e.addressId,
      allowanceArray: e.allowanceArray,
      clientName: e.name,
    }));
    const allowancePerClient = ClientsData.map((item) => {
      return item.allowanceArray.map((allowanceItem) => ({
        allocation: allowanceItem.allowance,
        addressId: item.addressId,
        allocationTimestamp: allowanceItem.createMessageTimestamp,
        clientName: item.clientName,
      }));
    }).flat();

    return allowancePerClient;
  },

  getClientsDeals: async (verifierClientsData: ClientsByVerifier[]): Promise<ClientsDeals[]> => {
    const clientAddressIds = verifierClientsData.map((e) => e.addressId);
    try {
      db.connect();

      const query = `
  SELECT piece_size AS deal_value, client AS client_id, start_epoch AS deal_timestamp
  FROM current_state 
  WHERE client = ANY($1::text[]) AND start_epoch != -1
  ORDER BY client, start_epoch
`;

      const values = [clientAddressIds];

      const result = await db.query(query, values);
      //todo make calculations inside db query
      const data = result.rows.map((row) => ({
        ...row,
        deal_timestamp: heightToUnix(Number(row.deal_timestamp)),
        deal_value: BigInt(row.deal_value),
      }));
      return data;
    } catch (error) {
      throw new Error('Error getting clients deals data from the DB: ' + error);
    }
  },

  getDatacapInClientsChart: async (
    clientInfo: {
      addressId: string;
      allocations: {
        allocation: number;
        allocationTimestamp: number;
      }[];
    }[],
    clientsDeals: ClientsDeals[]
  ) => {
    const allocationDeals = {
      first: reportRepository.generateInitialGroups(),
      quarter: reportRepository.generateInitialGroups(),
      half: reportRepository.generateInitialGroups(),
      third: reportRepository.generateInitialGroups(),
      full: reportRepository.generateInitialGroups(),
    };

    function updateAllocationDeals(deals: { x: string; y: number }[], diff: number) {
      if (diff < 1) {
        deals[0].y += 1;
      } else if (diff >= 1 && diff < 12) {
        deals[1].y += 1;
      } else if (diff >= 12 && diff < 24) {
        deals[2].y += 1;
      } else if (diff >= 24 && diff < 48) {
        deals[3].y += 1;
      } else {
        deals[4].y += 1;
      }
    }

    const groupedClientDeals = clientsDeals.reduce((groups: Record<string, ClientsDeals[]>, deal) => {
      const key = deal.client_id;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(deal);
      return groups;
    }, {});

    clientInfo.forEach((client) => {
      let dealIdx = 0;
      for (const { allocation, allocationTimestamp } of client.allocations) {
        let allocationUsed = 0n;
        let threshold = 0;
        for (let i = dealIdx; i < groupedClientDeals[client.addressId]?.length; i++) {
          const deal = clientsDeals[i];

          allocationUsed += deal.deal_value;
          if (threshold === 0) {
            updateAllocationDeals(allocationDeals.first, deal?.deal_timestamp - allocationTimestamp);
            threshold = 1;
          }
          if (threshold === 1 && allocationUsed >= allocation * 0.25) {
            updateAllocationDeals(allocationDeals.quarter, deal.deal_timestamp - allocationTimestamp);
            threshold = 2;
          } else if (threshold === 2 && allocationUsed >= allocation * 0.5) {
            updateAllocationDeals(allocationDeals.half, deal.deal_timestamp - allocationTimestamp);
            threshold = 3;
          } else if (threshold === 3 && allocationUsed >= allocation * 0.75) {
            updateAllocationDeals(allocationDeals.third, deal.deal_timestamp - allocationTimestamp);
            threshold = 4;
          } else if (threshold === 4 && allocationUsed >= allocation) {
            updateAllocationDeals(allocationDeals.full, deal.deal_timestamp - allocationTimestamp);
            threshold = 5;
            dealIdx = i + 1;
            break;
          }
        }
      }
    });

    const charts: string[] = Object.keys(allocationDeals).map((key) => {
      const datasets: BarChartEntry[] = [
        {
          backgroundColor: LABELS.map(() => reportUtils.randomizeColor()),
          data: allocationDeals[key as keyof typeof allocationDeals],
          categoryPercentage: 1,
          barPercentage: 1,
        },
      ];

      return GenerateChart.getBase64HistogramImage(datasets, {
        labels: LABELS,
        title: `Deals made by clients until reached ${key} Datacap allocation`,
        titleYText: 'Amount of deals made',
        titleXText: `Time from Datacap issuance to ${key} Datacap allocation (hours)`,
        width: 2000,
      });
    });

    return charts;
  },

  getBarChartImage: async (grantedDatacapByVerifier: GrantedDatacapByVerifier[]) => {
    const legendOpts: Partial<LegendOptions<'bar'> & { labels: any }> = {
      display: true,
      labels: {
        generateLabels: () => [],
      },
    };
    const preparedTimestamp = grantedDatacapByVerifier
      .map((e) => {
        const formattedDate = dayjs(e.allocationTimestamp * 1000)
          .startOf('day')
          .valueOf();
        return { ...e, allocationTimestamp: formattedDate };
      })
      .sort((a, b) => a.allocationTimestamp - b.allocationTimestamp);

    const groupedByAllocationTimestamp = preparedTimestamp.reduce(
      (groups: Record<string, typeof grantedDatacapByVerifier>, allocation) => {
        const key = dayjs(allocation.allocationTimestamp).format('YYYY-MM-DD');
        if (!groups[key]) {
          groups[key] = [];
        }

        groups[key].push(allocation);
        return groups;
      },
      {}
    );
    const data = Object.entries(groupedByAllocationTimestamp).map(([allocationTimestamp, allocations]) => {
      return {
        x: allocationTimestamp,
        y: allocations.reduce((acc, curr) => acc + curr.allocation, 0),
      };
    });

    const datasets = [
      {
        data: data,
        backgroundColor: data.map(() => reportUtils.randomizeColor()),
        borderWidth: 2,
      },
    ];

    return GenerateChart.getBase64Image(datasets, {
      title: 'Size of Datacap issuance over time by client address ID',
      titleYText: 'Size of Issuance',
      titleXText: 'Date of Issuance',
      legendOpts,
      width: 3500,
      labels: data.map((e) => e.x),
    });
  },
  uploadFile: async (basepath: string, base64: string, name: string, ext: string) => {
    const filePath = path.join(basepath, `${name}.${ext}`);
    try {
      fs.mkdirSync(basepath, { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      return filePath;
    } catch (e) {
      throw new Error('Error writing file' + e);
    }
  },
  generateInitialGroups: () => {
    return LABELS.map((x) => ({ x, y: 0 }));
  },
};
