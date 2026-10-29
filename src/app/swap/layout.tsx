import Providers from '@/app/providers';

export default function SwapLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
