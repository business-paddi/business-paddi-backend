import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getStatus(): string {
    return 'Backend is running';
  }

  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
