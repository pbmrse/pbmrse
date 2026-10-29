export async function GET(request: Request) {
  const lang = new URL(request.url).searchParams.get('lang') || 'en';
  const wantsChinese = lang === 'zh-CN' || lang === 'zh-TW';
  const feeds = wantsChinese
    ? ['https://www.coindesk.com/zh/arc/outboundfeeds/rss/', 'https://www.coindesk.com/arc/outboundfeeds/rss/']
    : ['https://www.coindesk.com/arc/outboundfeeds/rss/'];

  try {
    let xml = '';
    let localizedFeed = false;

    for (const feed of feeds) {
      try {
        const response = await fetch(feed, {
          headers: { accept: 'application/rss+xml,text/xml' },
          next: { revalidate: 900 },
        });
        if (!response.ok) continue;
        xml = await response.text();
        localizedFeed = feed.includes('/zh/');
        break;
      } catch {}
    }

    if (!xml) return Response.json({ items: [] }, { status: 502 });

    const itemMatches = xml.split('<item>').slice(1).map((part) => part.split('</item>')[0]);
    const items = itemMatches.slice(0, 8).map((raw) => {
      const pick = (tag: string) => {
        const cdataStart = `<${tag}><![CDATA[`;
        const cdataEnd = `]]></${tag}>`;
        const start = raw.indexOf(cdataStart);
        if (start >= 0) {
          const valueStart = start + cdataStart.length;
          const end = raw.indexOf(cdataEnd, valueStart);
          if (end >= 0) return raw.slice(valueStart, end).trim();
        }
        const plainStart = raw.indexOf(`<${tag}>`);
        if (plainStart >= 0) {
          const valueStart = plainStart + tag.length + 2;
          const end = raw.indexOf(`</${tag}>`, valueStart);
          if (end >= 0) return raw.slice(valueStart, end).trim();
        }
        return '';
      };

      let link = pick('link');
      if (wantsChinese && !localizedFeed && link.startsWith('https://www.coindesk.com/')) {
        const path = link.slice('https://www.coindesk.com/'.length);
        link = 'https://www.coindesk.com/zh/' + path;
      }

      return { title: pick('title'), link, pubDate: pick('pubDate') };
    }).filter((item) => item.title && item.link);

    return Response.json({ items }, { headers: { 'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=1800' } });
  } catch {
    return Response.json({ items: [] }, { status: 502 });
  }
}
