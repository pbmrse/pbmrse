import Providers from '@/app/providers';

export default function MiningLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
