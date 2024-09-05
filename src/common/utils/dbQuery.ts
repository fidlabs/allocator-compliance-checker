export const clientDealsQuery = `
SELECT * FROM aggregated_client_deals WHERE client = ANY ($1)`;

export const providerDistributionQuery = `
 SELECT provider,
        total_deal_size,
        unique_data_size,
        (total_deal_size::FLOAT - unique_data_size) / total_deal_size::FLOAT AS duplication_percentage
  FROM provider_distribution
  WHERE client = ANY ($1)
  ORDER BY total_deal_size DESC;`;

export const generatedReportQuery = `SELECT * FROM generated_reports WHERE client_address_id = $1 ORDER BY created_at DESC LIMIT 1`;

export const storeReportQuery = `insert into allocator_generated_reports (address, address_id, name, url) values ($1, $2, $3, $4)`;
export const listReportsQuery = `select distinct on (address) address, address_id, name, url, created_at from allocator_generated_reports order by address desc, created_at desc`;
export const getLatestReportQuery = `select url from allocator_generated_reports where address = $1 or address_id = $1 order by created_at desc limit 1`;
