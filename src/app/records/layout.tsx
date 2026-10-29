import Providers from '@/app/providers';

export default function RecordsLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
