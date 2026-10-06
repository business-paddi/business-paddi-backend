import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import maxmind, { type CityResponse, type Reader } from 'maxmind';
import path from 'node:path';
import {
  getRequestMetadata,
  type RequestMetadata,
} from '../common/utils/request-metadata';
import {
  isPrivateIpAddress,
  normalizeIpAddress,
} from '../common/utils/ip-address';
import type { IpLocation, LocationMetadata } from './location.types';

const EMPTY_LOCATION: Readonly<IpLocation> = {
  country: null,
  region: null,
  city: null,
  timezone: null,
  latitude: null,
  longitude: null,
  provider: 'maxmind',
};

export interface RequestLocationContext {
  requestMetadata: RequestMetadata;
  location: LocationMetadata;
}

@Injectable()
export class LocationService implements OnModuleInit {
  private readonly logger = new Logger(LocationService.name);
  private readonly databasePath: string;
  private cityLookup: Reader<CityResponse> | null = null;

  constructor(configService: ConfigService) {
    this.databasePath = path.resolve(
      configService.get<string>('MAXMIND_DB_PATH', 'data/GeoLite2-City.mmdb'),
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      this.cityLookup = await maxmind.open<CityResponse>(this.databasePath, {
        watchForUpdates: true,
        watchForUpdatesNonPersistent: true,
      });
      this.logger.log(
        `GeoLite2 City database loaded from ${this.databasePath}`,
      );
    } catch (error) {
      this.logger.error(
        `Could not load the GeoLite2 City database at ${this.databasePath}. Run "npm run maxmind:download" before starting the application.`,
      );
      throw error;
    }
  }

  getLocationFromIp(ipAddress: string | null): IpLocation {
    const ip = normalizeIpAddress(ipAddress);

    if (!ip || !this.cityLookup || isPrivateIpAddress(ip)) {
      return { ...EMPTY_LOCATION };
    }

    const result = this.cityLookup.get(ip);

    if (!result) {
      return { ...EMPTY_LOCATION };
    }

    return {
      country: result.country?.names.en ?? null,
      region: result.subdivisions?.[0]?.names.en ?? null,
      city: result.city?.names.en ?? null,
      timezone: result.location?.time_zone ?? null,
      latitude: result.location?.latitude ?? null,
      longitude: result.location?.longitude ?? null,
      provider: 'maxmind',
    };
  }

  getRequestContext(request: Request): RequestLocationContext {
    const requestMetadata = getRequestMetadata(request);
    const { country, region, city } = this.getLocationFromIp(
      requestMetadata.ipAddress,
    );

    return {
      requestMetadata,
      location: { country, region, city },
    };
  }
}
