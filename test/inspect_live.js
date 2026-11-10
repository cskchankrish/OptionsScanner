import https from 'https';

https.get('https://niftyninjaa.vercel.app/api/nifty-oi', res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const json = JSON.parse(data);
    const tl = json.intradayTimeline || [];
    console.log('Count:', tl.length);
    console.log('First 5:', tl.slice(0, 5).map(t => t.time));
    console.log('Last 15:', tl.slice(-15).map(t => `${t.time} (min:${t.minutes}, live:${t.isLiveTick})`));
  });
});
