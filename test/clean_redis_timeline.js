import https from 'https';

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fixTimeline() {
  console.log('Fetching current timeline from niftyninjaa...');
  const res = await request('https://niftyninjaa.vercel.app/api/nifty-oi');
  const tl = res.data.intradayTimeline || [];
  console.log('Total ticks before cleanup:', tl.length);

  // We want ONLY real live ticks from today's session (minutes between 840 and current time, e.g. 14:00 to now)
  const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const nowMins = nowIst.getHours() * 60 + nowIst.getMinutes();
  console.log('Current IST time:', nowIst.toLocaleTimeString(), 'nowMins:', nowMins);

  // Keep only ticks that belong to today's active session and are not in the future
  // Sunday trading opened at 14:00 (840)
  const cleanTodayTicks = tl.filter(t => t.minutes >= 840 && t.minutes <= nowMins && t.isLiveTick);
  
  // If there are only 1 or 2 live ticks, let's keep the true live tick
  const latestLiveTick = tl.filter(t => t.isLiveTick).slice(-1)[0] || {
    time: "14:30",
    minutes: nowMins,
    putWriting: res.data.totalPutWriting,
    callWriting: res.data.totalCallWriting,
    netDiff: res.data.totalPutWriting - res.data.totalCallWriting,
    spot: res.data.spotPrice,
    isLiveTick: true
  };

  const finalTicks = cleanTodayTicks.length > 0 ? cleanTodayTicks : [latestLiveTick];
  console.log('Clean ticks to save for today:', finalTicks.length, finalTicks);

  console.log('Sending replaceTimeline to https://niftyninjaa.vercel.app/api/nifty-oi ...');
  const postRes = await request('https://niftyninjaa.vercel.app/api/nifty-oi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({
    replaceTimeline: true,
    timeline: finalTicks
  }));

  console.log('POST status:', postRes.status, postRes.data);

  // Verify
  const verifyRes = await request('https://niftyninjaa.vercel.app/api/nifty-oi');
  console.log('Verified timeline length in API now:', verifyRes.data.intradayTimeline?.length);
  console.log('Verified ticks:', verifyRes.data.intradayTimeline?.map(t => `${t.time} (${t.minutes})`));
}

fixTimeline().catch(console.error);
