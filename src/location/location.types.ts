export interface IpLocation {
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  provider: 'maxmind';
}

export type LocationMetadata = Pick<IpLocation, 'country' | 'region' | 'city'>;
