import { Injectable } from '@nestjs/common';
import { BANK_CATALOGUE_SNAPSHOT } from './bank-catalogue.snapshot';
import type { Bank } from './bank-catalogue.types';
import type { BankQueryDto } from './banks.dto';

@Injectable()
export class BanksService {
  private readonly banks = [...BANK_CATALOGUE_SNAPSHOT].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id, 'en'),
  );

  list(query: BankQueryDto = {}): { items: Bank[] } {
    const q = query.q?.trim().toLowerCase();
    const country = query.country?.trim().toLowerCase();
    const currency = query.currency?.trim().toLowerCase();
    return {
      items: this.banks
        .filter(
          (bank) =>
            (!country || bank.country.toLowerCase() === country) &&
            (!currency || bank.currency.toLowerCase() === currency) &&
            (!q ||
              [bank.name, bank.code, bank.slug].some((value) =>
                value.toLowerCase().includes(q),
              )),
        )
        .map((bank) => ({ ...bank })),
    };
  }
}
