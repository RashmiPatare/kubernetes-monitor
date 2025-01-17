import { logger } from '../common/logger';
import { config } from '../common/config';
import { sendRuntimeData } from '../transmitter';
import { constructRuntimeData } from '../transmitter/payload';
import { retryRequest } from '../transmitter';
import { IRuntimeImagesResponse } from '../transmitter/types';
import { NeedleOptions } from 'needle';
import { Agent as HttpsAgent } from 'https';

const httpsAgent = new HttpsAgent({
  keepAlive: true,
  // We agreed with Sysdig to skip TLS certificates validation for HTTPS connection.
  rejectUnauthorized: false,
});

function getSysdigV1Url(): string {
  return config.SYSDIG_ENDPOINT + '/v1/runtimeimages';
}
function getSysdigV1AuthHeader(): string {
  return `Bearer ${config.SYSDIG_TOKEN}`;
}

function isSuccessStatusCode(statusCode: number | undefined): boolean {
  return statusCode !== undefined && statusCode >= 200 && statusCode < 300;
}

/** NOTE: This function can throw, so the caller should handle errors. */
export async function validateConnectivityV1(): Promise<void> {
  const url = getSysdigV1Url();
  const header = getSysdigV1AuthHeader();
  const reqOptions: NeedleOptions = {
    agent: httpsAgent,
    headers: {
      authorization: header,
    },
    timeout: 10_000,
  };

  const limit: number = 1;
  const cursor: string = '';
  const { response } = await retryRequest(
    'get',
    `${url}?limit=${limit}&cursor=${cursor}`,
    {},
    reqOptions,
  );
  if (!isSuccessStatusCode(response.statusCode)) {
    throw new Error(`${response.statusCode} ${response.statusMessage}`);
  }
}

export async function scrapeDataV1(): Promise<void> {
  const url = getSysdigV1Url();
  const header = getSysdigV1AuthHeader();

  // limit: min 1, max 500, default 250
  const limit: number = 10;
  const reqOptions: NeedleOptions = {
    agent: httpsAgent,
    headers: {
      authorization: header,
    },
  };

  let cursor: string = '';
  while (true) {
    try {
      logger.info({ cursor }, 'attempting to get runtime images');

      const { response, attempt } = await retryRequest(
        'get',
        `${url}?limit=${limit}&cursor=${cursor}`,
        {},
        reqOptions,
      );
      if (!isSuccessStatusCode(response.statusCode)) {
        throw new Error(`${response.statusCode} ${response.statusMessage}`);
      }

      logger.info(
        {
          attempt,
          cursor,
        },
        'runtime images received successfully',
      );

      const responseBody: IRuntimeImagesResponse | undefined = response.body;
      const runtimeDataPayload = constructRuntimeData(
        responseBody?.data ?? [],
        1,
      );

      logger.info({}, 'sending runtime data upstream');
      await sendRuntimeData(runtimeDataPayload);

      cursor = responseBody?.page.next || '';
      if (!cursor) {
        break;
      }
    } catch (error) {
      logger.error(
        {
          error,
          cursor,
        },
        'could not get runtime images',
      );
      break;
    }
  }
}
