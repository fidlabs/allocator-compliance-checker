import { resolve4, resolve6 } from 'node:dns';

import axios from 'axios';
import { LegendOptions } from 'chart.js';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import utc from 'dayjs/plugin/utc';
dayjs.extend(duration);
dayjs.extend(utc);

let arraystat: any;

import('arraystat').then((module) => {
  arraystat = module.default;
});

import fs from 'fs';
import { Multiaddr } from 'multiaddr';
import { emojify } from 'node-emoji';
import path from 'path';
import xbytes from 'xbytes';

import { axiosConfig } from '@/common/utils/axiosConfig';
import GenerateChart, { BarChartEntry } from '@/common/utils/charts/generateChart';
import GeoMap from '@/common/utils/charts/geoMap';
import {
  clientDealsQuery,
  generatedReportQuery,
  getLatestReportQuery,
  providerDistributionQuery,
  storeReportQuery,
} from '@/common/utils/dbQuery';
import { env } from '@/common/utils/envConfig';
import { getCurrentEpoch, heightToUnix } from '@/common/utils/filplusEpoch';
import { getInfoFromGithubIssueUrl } from '@/common/utils/github';
import { isNotEmpty } from '@/common/utils/typeGuards';
import { db } from '@/db';
import { logger } from '@/server';

import {
  Allocator,
  ClientsByVerifier,
  ClientsByVerifierData,
  ClientsDeals,
  FlaggedClientsInfo,
  GeoMapEntry,
  GetVerifiedClientsResponse,
  getVerifierClientsDataResponse,
  GetVerifiersDataItem,
  GetVerifiersResponse,
  GrantedDatacapInClients,
  Location,
  MinerInfo,
  ProviderDistribution,
  ProviderDistributionTable,
  Retrievability,
  SparkSuccessRate,
} from './reportModel';
import { formattedTimeDiff, generateClientsRow, reportUtils } from './reportUtils';

export const reportRepository = {
  generateReport: async (
    verifiersData: GetVerifiersDataItem,
    clientsData: ClientsByVerifierData,
    flaggedClientsInfo: FlaggedClientsInfo[],
    grantedDatacapInClients: GrantedDatacapInClients[],
    clientsDeals: ClientsDeals[],
    grantedDatacapInProviders: ProviderDistributionTable[],
    reportGenTs: number
  ): Promise<any> => {
    let content: string[] = [];
    const datacapInClientsDist = reportUtils.datacapInClients(grantedDatacapInClients);
    const { datacapInClientsCharts, timeToFirstDeal } = await reportRepository.getDatacapInClientsChart(
      datacapInClientsDist,
      clientsDeals
    );

    content.push(`# Compliance Report - ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`);
    content.push("## Allocator's Info");
    const header = await reportRepository.reportHeaderContent(
      verifiersData,
      grantedDatacapInProviders,
      timeToFirstDeal,
      Number(datacapInClientsDist.length)
    );
    content = [...content, ...header];

    if (Number(clientsData.count)) {
      const clientsRows = await Promise.all(
        clientsData.data.map((e) => generateClientsRow(e, flaggedClientsInfo, reportRepository))
      );
      // Generate bar chart image for clients datacap issuance
      content.push('');
      content.push('## List of clients and their allocations');
      content.push('');
      content.push("| ID | Name | Number of Allocations | Total Allocations | Interactions With SP's | CID Report |");
      content.push('|-|-|-|-|-|-|');
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

      content.push('## Distribution of Datacap in Clients');
      content.push('');

      //generate histogram images based on clients allocation and deals made
      datacapInClientsCharts.map(async (chart, idx) => {
        const filePath = await reportRepository.saveFile(
          chart,
          `${verifiersData.addressId}/${reportGenTs}/datacap_in_clients/histogram_${idx}.png`
        );
        content.push('');
        content.push(`<div class="histogram"><img src=${filePath}></div>`);
        content.push('');
      });

      //calculate distinct sizes of allocations table
      const distinctSizesOfAllocations = reportUtils.distinctSizesOfAllocations(grantedDatacapInClients);
      content.push(distinctSizesOfAllocations);

      content.push('## Histograms of time passed until the part of the allocation is used by the clients');
      content.push('');

      const getBarChartImage = await reportRepository.getBarChartImage(grantedDatacapInClients);
      const barChartUrl = await reportRepository.saveFile(
        getBarChartImage,
        `${verifiersData.addressId}/${reportGenTs}/issuance_chart.png`
      );
      content.push(`<img src="${barChartUrl}"/>`);
      content.push('');

      content.push('## Distribution of Datacap in Storage Providers');
      content.push('');
      content.push(
        '| Provider | Location | Total Deals Sealed | Percentage of Total Datacap | Retrieval Success Rate |'
      );
      content.push('|-|-|-|-|-|');
      grantedDatacapInProviders.forEach((provider) => {
        content.push(
          `| ${provider.provider} | ${provider.location?.city || '-'} | ${provider.total_sealed_deals.toString()} | ${provider.percentage.toFixed(
            2
          )} % | ${((provider.retrieval_success_rate ?? 0) * 100).toFixed(2) + '%' || '-'} |`
        );
      });

      // Generate image for provider distribution
      const providersGeoMap = reportRepository.getImageForProviderDistribution(grantedDatacapInProviders);

      const geoMapUrl = await reportRepository.saveFile(
        providersGeoMap,
        `${verifiersData.addressId}/${reportGenTs}/providers_distribution_geomap.png`
      );
      content.push('');
      content.push('## Location of Clients and Storage Providers with the Percentage of Total Datacap Displayed');
      content.push(`<img src="${geoMapUrl}"/>`);
      content.push('');

      content.push('## Detailed Allocations per Client');
      content.push('');
      const detailedAllocationsPerClient = await reportRepository.detailedAllocationsPerClient(clientsData.data);
      detailedAllocationsPerClient.forEach((client) => {
        client.forEach((row) => content.push(row));
        content.push('');
      });
    } else {
      content.push('### No Datacap issued for allocator');
    }
    const joinedContent = Buffer.from(content.join('\n')).toString('base64');
    const reportUrl = await reportRepository.saveFile(
      joinedContent,
      `${verifiersData.addressId}/${reportGenTs}/report.md`
    );

    return reportUrl;
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

  getGrantedDatacapInProviders: async (VerifierClientsData: ClientsByVerifier[]) => {
    const distribution = await reportRepository.getStorageProvidersDistribution(
      VerifierClientsData.map((e) => e.addressId)
    );
    return distribution;
  },

  getGrantedDatacapInClients: (VerifierClientsData: ClientsByVerifier[]): GrantedDatacapInClients[] => {
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
    })
      .flat()
      .sort((a, b) => a.allocationTimestamp - b.allocationTimestamp);

    return allowancePerClient;
  },

  getStorageProvidersDistribution: async (clients: string[]): Promise<ProviderDistributionTable[] | []> => {
    const currentEpoch = getCurrentEpoch();
    logger.info({ clients, currentEpoch }, 'Getting storage provider distribution');
    const queryResult = await db.query(providerDistributionQuery, [clients, currentEpoch]);
    const distributions: ProviderDistribution[] = queryResult.rows;
    const providers = distributions.map((r) => r.provider);
    if (providers.length === 0) {
      logger.debug('No storage providers found for' + clients);
      return [];
    }
    logger.debug({ distributions }, 'Got Storage provider distribution');

    const total = distributions.reduce((acc, cur) => acc + parseFloat(cur.total_deal_size), 0);

    const providersRetrievability = await reportRepository.providersRetrievability(
      distributions,
      env.RETRIEVABILITY_RANGE_DAYS
    );

    const retrievabilityMap = new Map(
      providersRetrievability.retrievability.map((x) => [x.provider_id, x.success_rate])
    );

    const locationPromises = distributions.map((item) => reportRepository.getLocation(item.provider));
    const locations = await Promise.all(locationPromises);

    const ProvidersDistribution: ProviderDistributionTable[] = distributions.map((item, index) => {
      const retrieval_success_rate = retrievabilityMap.get(item.provider) || null;
      const total_sealed_deals = xbytes(parseFloat(item.total_deal_size), { iec: true });
      const percentage = (parseFloat(item.total_deal_size) / total) * 100;

      return {
        provider: item.provider,
        location: locations[index],
        retrieval_success_rate,
        total_sealed_deals,
        percentage,
      };
    });

    return ProvidersDistribution;
  },

  providersRetrievability: async (
    providerDistributions: ProviderDistribution[],
    retrievabilityRange: number
  ): Promise<{ retrievability: Retrievability[]; avgProviderScore: number }> => {
    try {
      const from = new Date(Date.now() - retrievabilityRange * 24 * 3600 * 1000).toISOString().split('T')[0];
      const to = new Date().toISOString().split('T')[0];

      const sparkData = await reportRepository.fetchRetrievalSuccessRate(from, to);

      const retrievability = reportRepository.createRetrievability(providerDistributions, sparkData);
      if (retrievability.length === 0) return { retrievability: [], avgProviderScore: 0 };

      const avgProviderScore = reportRepository.calculateAvgProviderScore(retrievability);

      return { retrievability, avgProviderScore };
    } catch (error) {
      logger.error('Error getting retrievability data: ' + error);
      return { retrievability: [], avgProviderScore: 0 };
    }
  },

  calculateAvgProviderScore: (matchedRetrievability: Retrievability[]): number => {
    const { totalClientDealSize, totalSuccessRate } = matchedRetrievability.reduce(
      (acc, { total_deal_size, success_rate }) => {
        acc.totalClientDealSize += total_deal_size;
        acc.totalSuccessRate += success_rate * total_deal_size;
        return acc;
      },
      { totalClientDealSize: 0, totalSuccessRate: 0 }
    );

    if (totalSuccessRate === 0 || totalClientDealSize === 0) return 0;
    return totalSuccessRate / totalClientDealSize;
  },

  createRetrievability: (
    providerDistributions: ProviderDistribution[],
    sparkData: SparkSuccessRate[]
  ): Retrievability[] => {
    const retrievability = providerDistributions
      .map(({ provider, total_deal_size }) => {
        const sparkItem = sparkData.find((x) => x.miner_id === provider);

        if (!sparkItem) return null;

        return {
          provider_id: sparkItem.miner_id,
          success_rate: sparkItem.success_rate,
          total_deal_size: Number(total_deal_size),
        };
      })
      .filter(isNotEmpty);

    return retrievability;
  },

  fetchRetrievalSuccessRate: async (from: string, to: string): Promise<SparkSuccessRate[]> => {
    const response = await axios.get(
      `https://stats.filspark.com/miners/retrieval-success-rate/summary?from=${from}&to=${to}`
    );
    const sparkData: SparkSuccessRate[] = response.data;

    return sparkData;
  },

  getLocation: async (provider: string): Promise<Location | null> => {
    const minerInfo = await reportRepository.getMinerInfo(provider);
    if (minerInfo.Multiaddrs == null || minerInfo.Multiaddrs.length === 0) {
      return null;
    }
    const ips: string[] = [];
    for (const multiAddr of minerInfo.Multiaddrs) {
      logger.info({ multiAddr }, 'Getting IP from multiaddr');
      try {
        const ip = await reportRepository.getIpFromMultiaddr(multiAddr);
        ips.push(...ip);
      } catch (e) {
        logger.warn({ multiAddr, e }, 'Failed to get IP from multiaddr');
        return null;
      }
    }
    for (const ip of ips) {
      logger.info({ ip }, 'Getting location for IP');
      const { data } = await axios.get(`https://ipinfo.io/${ip}?token=${env.IP_INFO_TOKEN}`);
      if (data.bogon === true) {
        continue;
      }
      logger.info({ ip, data }, 'Got location for IP');
      return {
        city: data.city,
        country: data.country,
        region: data.region,
        latitude: data.loc != null ? parseFloat(data.loc.split(',')[0]) : undefined,
        longitude: data.loc != null ? parseFloat(data.loc.split(',')[1]) : undefined,
        orgName: data.org != null ? data.org.split(' ').slice(1).join(' ') : 'Unknown',
      };
    }
    return null;
  },

  getIpFromMultiaddr: async (multiAddr: string): Promise<string[]> => {
    const m = new Multiaddr(Buffer.from(multiAddr, 'base64'));
    const address = m.nodeAddress().address;
    const proto = m.protos()[0].name;
    switch (proto) {
      case 'dns4':
        return resolve4.__promisify__(address);
      case 'dns6':
        return resolve6.__promisify__(address);
      case 'ip4':
      case 'ip6':
        return [address];
      default:
        logger.error({ multiAddr }, 'Unknown protocol');
        return [];
    }
  },

  getMinerInfo: async (miner: string): Promise<MinerInfo> => {
    logger.info({ miner }, 'Getting miner info');

    const response = await axios.post('https://api.node.glif.io/rpc/v0', {
      jsonrpc: '2.0',
      id: 1,
      method: 'Filecoin.StateMinerInfo',
      params: [miner, null],
    });
    return response.data.result;
  },

  getClientsDeals: async (verifierClientsData: ClientsByVerifier[]): Promise<ClientsDeals[]> => {
    const clientAddressIds = verifierClientsData.map((e) => e.addressId);
    try {
      const values = [clientAddressIds];

      const result = await db.query(clientDealsQuery, values);

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
    const timeToReachThreshold: Record<string, number[]> = {
      first: [],
      half: [],
      third: [],
      full: [],
    };

    const allocationUnused: Record<string, number> = {
      first: 0,
      half: 0,
      third: 0,
      full: 0,
    };

    const unknownAllocations: Record<string, number> = {
      first: 0,
      half: 0,
      third: 0,
      full: 0,
    };

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
        for (; dealIdx < groupedClientDeals[client.addressId]?.length; dealIdx++) {
          const deal = groupedClientDeals[client.addressId][dealIdx];

          const allocationDate = dayjs.unix(allocationTimestamp);
          const dealDate = dayjs.unix(deal.deal_timestamp);
          allocationUsed += deal.deal_value;
          const diff = dealDate.diff(allocationDate, 'days');

          if (threshold === 0) {
            if (diff < 0) {
              unknownAllocations.first++;
            } else {
              timeToReachThreshold.first.push(diff);
            }
            threshold = 1;
          }
          if (threshold === 1 && allocationUsed >= allocation * 0.5) {
            if (diff < 0) {
              unknownAllocations.half++;
            } else {
              timeToReachThreshold.half.push(diff);
            }
            threshold = 2;
          }
          if (threshold === 2 && allocationUsed >= allocation * 0.75) {
            if (diff < 0) {
              unknownAllocations.third++;
            } else {
              timeToReachThreshold.third.push(diff);
            }
            threshold = 3;
          }
          if (threshold === 3 && allocationUsed >= allocation) {
            if (diff < 0) {
              unknownAllocations.full++;
            } else {
              timeToReachThreshold.full.push(diff);
            }
            threshold = 4;
            break;
          }
        }

        switch (threshold) {
          case 0:
            allocationUnused.first++;
          // falls through
          case 1:
            allocationUnused.half++;
          // falls through
          case 2:
            allocationUnused.third++;
          // falls through
          case 3:
            allocationUnused.full++;
        }
      }
    });

    const chartData = Object.keys(timeToReachThreshold).reduce(
      (acc: Record<string, { x: string; y: number }[]>, key) => {
        if (timeToReachThreshold[key].length === 1) {
          acc[key] = [];
        } else {
          acc[key] = arraystat(timeToReachThreshold[key]).histogram?.map(
            (data: { min: number; max: number; nb: number }) => {
              return {
                x: `${Math.floor(data.min)} - ${Math.floor(data.max)}`,
                y: data.nb,
              };
            }
          );
        }
        acc[key]?.length &&
          acc[key].unshift({
            x: 'Unknown',
            y: unknownAllocations[key],
          });

        acc[key]?.length &&
          acc[key].push({
            x: 'Unused',
            y: allocationUnused[key],
          });
        return acc;
      },
      {}
    );

    const datacapInClientsCharts: string[] = Object.keys(chartData).map((key) => {
      const datasets: BarChartEntry[] = [
        {
          backgroundColor: chartData[key]?.map(() => '#a2d2ff'),
          data: chartData[key],
          categoryPercentage: 1,
          barPercentage: 1,
        },
      ];
      let title = '';
      switch (key) {
        case 'first':
          title = "Time elapsed until the client's first deal was made";
          break;
        case 'half':
          title = 'Time elapsed until half of the allocation was used';
          break;
        case 'third':
          title = 'Time elapsed until three quarters of the allocation was used';
          break;
        case 'full':
          title = 'Time elapsed until the entire allocation was used';
          break;
      }

      return new GenerateChart().getBase64HistogramImage(datasets, {
        labels: chartData[key]?.map((e) => e.x),
        title,
        titleYText: 'Number of Allocations',
        titleXText: `Time from Allocation issuance (days)`,
        width: 2000,
      });
    });

    return { datacapInClientsCharts, timeToFirstDeal: timeToReachThreshold.first };
  },

  getBarChartImage: async (grantedDatacapInClients: GrantedDatacapInClients[]) => {
    const legendOpts: Partial<LegendOptions<'bar'> & { labels: any }> = {
      display: true,
      labels: {
        generateLabels: () => [],
      },
    };
    const preparedTimestamp = grantedDatacapInClients.map((e) => {
      const formattedDate = dayjs(e.allocationTimestamp * 1000)
        .startOf('day')
        .valueOf();
      return { ...e, allocationTimestamp: formattedDate };
    });

    const groupedByAllocationTimestamp = preparedTimestamp.reduce(
      (groups: Record<string, typeof grantedDatacapInClients>, allocation) => {
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
        backgroundColor: data.map(() => '#d1e2d0'),
        borderWidth: 2,
      },
    ];

    return new GenerateChart().getBase64Image(datasets, {
      title: 'Size of Datacap issuance over time',
      titleYText: 'Size of Issuance',
      titleXText: 'Date of Issuance',
      legendOpts,
      width: 2000,
      labels: data.map((e) => e.x),
    });
  },

  saveFile: async (base64Content: string, name: string): Promise<string> => {
    const filePath = path.join(env.UPLOADS_DIR, name);

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(base64Content, 'base64'));

      const url = new URL('uploads/' + name, env.APP_BASE_URL);
      return url.toString();
    } catch (e) {
      logger.error('Error uploading file %s: %s', filePath, e);
      throw new Error('Error uploading file');
    }
  },

  saveInDb: async (verifiersData: GetVerifiersDataItem, reportUrl: string) => {
    try {
      await db.query(storeReportQuery, [verifiersData.address, verifiersData.addressId, verifiersData.name, reportUrl]);
    } catch (error) {
      console.error('Failed to save report in db', error);
    }
  },

  getImageForProviderDistribution(providerDistributions: ProviderDistributionTable[]): string {
    const geoMapEntries: GeoMapEntry[] = [];

    for (const distribution of providerDistributions) {
      if (distribution.location?.longitude != null && distribution.location?.latitude != null) {
        geoMapEntries.push({
          longitude: distribution.location.longitude,
          latitude: distribution.location.latitude,
          value: Math.floor(distribution.percentage),
          label: distribution.provider,
        });
      }
    }
    return GeoMap.getImage(geoMapEntries);
  },
  constructBasepath: (uploadDir: string | undefined, addressId: string): string => {
    return uploadDir ? `${uploadDir}/${addressId}` : addressId;
  },
  reportHeaderContent: async (
    verifiersData: GetVerifiersDataItem,
    grantedDatacapInProviders: ProviderDistributionTable[],
    timeToFirstDeal: number[],
    numberOfClients: number
  ): Promise<string[]> => {
    const averageRetrievalScore = arraystat(grantedDatacapInProviders.map((x) => x.retrieval_success_rate)).avg;
    const averageRetrievalScorePct = averageRetrievalScore !== 0 ? (averageRetrievalScore * 100).toFixed(2) + '%' : '-';
    const averageTimeToFirstDeal = arraystat(timeToFirstDeal).avg;
    const allocatorInfo = await reportRepository.getAllocatorInfo(verifiersData.address);
    const content = [];

    content.push(`- Name: ${verifiersData.name}`);
    content.push(`- Id: ${verifiersData.addressId}`);
    content.push(`- Address: ${verifiersData.address}`);
    content.push(`- Filecoin Pulse: https://filecoinpulse.pages.dev/allocator/${verifiersData.addressId}`);
    content.push(`- Number of clients: ${numberOfClients}`);
    content.push(`- Is Multisig: ${verifiersData.isMultisig}`);
    content.push(`- Average retrievability success rate: ${averageRetrievalScorePct}`);
    content.push(
      `- Average time to first deal: ${averageTimeToFirstDeal ? averageTimeToFirstDeal.toFixed(2) + ' days' : '-'}`
    );
    content.push(`- Data Types: ${allocatorInfo?.data_types?.join(', ') || '-'}`);
    content.push(`- Required Copies: ${allocatorInfo?.required_replicas || '-'}`);
    return content;
  },
  detailedAllocationsPerClient: (clientsData: ClientsByVerifier[]): string[][] => {
    const data = clientsData.map((client) => {
      const content = [];
      content.push(
        `| Allowance | Client ID | Name | Issue Created |Allocation Amount | Time Since Previous Allocation | Time from Allocation Request to On-chain |`
      );
      content.push('|-|-|-|-|-|-|-|');
      client.allowanceArray.sort((a, b) => (a.createMessageTimestamp > b.createMessageTimestamp ? 1 : -1));
      client.allowanceArray.forEach((allocation, idx) => {
        const allocationDate = dayjs.unix(allocation.createMessageTimestamp);
        let durationBetweenAllocationRequest = '-';
        let timeFromAllocationToApproval = '-';
        let issueGhLink = '-';
        if (idx !== 0) {
          const previousAllocationDate = dayjs.unix(client.allowanceArray[idx - 1].createMessageTimestamp);
          durationBetweenAllocationRequest = formattedTimeDiff(previousAllocationDate, allocationDate);
        }
        if (idx === 0) {
          const issueCreateDate = dayjs.unix(allocation.issueCreateTimestamp);
          timeFromAllocationToApproval = formattedTimeDiff(issueCreateDate, allocationDate);
        }
        const allowance = xbytes(allocation.allowance);
        if (allocation.auditTrail) {
          const info = getInfoFromGithubIssueUrl(allocation.auditTrail);
          if (info) {
            const { owner, issueNumber } = info;
            issueGhLink = `[#${issueNumber} by ${owner}](${allocation.auditTrail})`;
          }
        }
        const issueCreated = dayjs.unix(allocation.createMessageTimestamp).utc().format('YYYY-MM-DD');

        content.push(
          `| ${issueGhLink} |${client.addressId} | ${client.name || '-'} | ${allowance} | ${issueCreated} | ${durationBetweenAllocationRequest} | ${timeFromAllocationToApproval} |`
        );
      });

      return content;
    });

    return data;
  },
  getClientCidReportUrl: async (address: string): Promise<string> => {
    try {
      const report = await db.query(generatedReportQuery, [address]);
      if (report.rows.length === 0) {
        return '-';
      }
      const path = env.ALLOCATOR_BASE_REPORT_URL + report.rows[0].file_path;
      const url = `[CID Report](${path})`;
      return url;
    } catch (error) {
      throw new Error('Error getting clients CID report data from the DB: ' + error);
    }
  },
  getAllocatorsData: async (): Promise<Allocator[] | undefined> => {
    try {
      const response = await axios.get(`${env.FILPLUS_BACKEND_API_URL}/allocators`);
      return response.data;
    } catch (error) {
      logger.error(`Error getting allocator tech data from ${env.FILPLUS_BACKEND_API_URL} API: ${error}`);
    }
  },
  getAllocatorInfo: async (address: string): Promise<Allocator | undefined> => {
    const data = await reportRepository.getAllocatorsData();
    return data?.find((x) => x.address === address);
  },
  getLatestReport: async (verifierAddress: string): Promise<string | null> => {
    const { rows } = await db.query(getLatestReportQuery, [verifierAddress]);

    if (rows.length > 0) {
      return rows[0].url;
    } else {
      return null;
    }
  },
};
