import https from 'https';

https.get('https://niftyninjaa.vercel.app/api/nifty-oi', res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const json = JSON.parse(data);
    console.log('Timestamp:', json.timestamp);
    console.log('SessionWindow:', json.sessionWindow);
    console.log('isLive:', json.isLive);
    console.log('isSettledSession:', json.isSettledSession);
    console.log('hasRedis:', json.hasRedis);
    console.log('Strikes count:', json.strikes?.length);
    console.log('Timeline count:', json.intradayTimeline?.length);
    const tl = json.intradayTimeline || [];
    console.log('First tick:', tl[0]);
    console.log('Middle tick (15:00):', tl.find(t => t.time === '15:00'));
    console.log('Last tick:', tl[tl.length - 1]);
  });
});
