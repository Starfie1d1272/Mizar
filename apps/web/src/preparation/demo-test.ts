export interface DemoTestView {
  readonly active: boolean;
  readonly phase: 'idle' | 'starting' | 'playing' | 'stopping' | 'recovery';
  readonly requestId: string | null;
  readonly teamAName: string;
  readonly teamBName: string;
  readonly dataReady: boolean;
}

export interface SelectedDemo {
  readonly token: string;
  readonly name: string;
}
