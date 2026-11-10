import https from 'https';

https.get('https://niftyninjaa.vercel.app/api/nifty-oi', res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const json = JSON.parse(data);
    const tl = json.intradayTimeline || [];
    console.log('Total ticks in API currently:', tl.length);
    const todayLiveTicks = tl.filter(t => t.minutes >= 840 && t.minutes <= 960 && (t.isLiveTick || t.time.startsWith('14:')));
    console.log('Valid today ticks (>= 14:00):', todayLiveTicks.length);
    console.log('Sample today ticks:', todayLiveTicks.map(t => `${t.time} (${t.spot}, net:${t.netDiff})`));
  });
});
