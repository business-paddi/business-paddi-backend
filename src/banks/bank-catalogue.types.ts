export type Bank = Readonly<{
  id: string;
  name: string;
  code: string;
  slug: string;
  country: string;
  currency: string;
  type: string;
}>;
