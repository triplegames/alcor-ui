import { SwapBar, Bar, Match } from '../../models'

export const resolutions = {
  1: 1 * 60,
  5: 5 * 60,
  15: 15 * 60,
  30: 30 * 60,
  60: 60 * 60,
  240: 60 * 60 * 4,
  '1D': 60 * 60 * 24,
  '1W': 60 * 60 * 24 * 7,
  '1M': 60 * 60 * 24 * 30
}

export async function markeBars(match) {
  const dbOperations = []

  Object.keys(resolutions).map(timeframe => {
    dbOperations.push(markeBar(timeframe, match))
  })

  await Promise.all(dbOperations)
}

export async function markeBar(timeframe, match) {
  const last_bar = await Bar.findOne({ chain: match.chain, market: match.market, timeframe }, {}, { sort: { time: -1 } })

  if (!last_bar) {
    //console.log('create first bar for market:', match.market, 'for timeframe:', timeframe)
    await Bar.create({
      timeframe,
      chain: match.chain,
      market: match.market,
      time: match.time,
      open: match.unit_price,
      high: match.unit_price,
      low: match.unit_price,
      close: match.unit_price,
      volume: match.type == 'buymatch' ? match.bid : match.ask
    })

    return
  }

  const resolution = resolutions[timeframe]

  const last_bar_end_time = last_bar.time.getTime() + resolution * 1000

  if (match.time.getTime() < last_bar_end_time) {
    // Match in the same timeframe as the last bar
    if (last_bar.high < match.unit_price) {
      last_bar.high = match.unit_price
    } else if (last_bar.low > match.unit_price) {
      last_bar.low = match.unit_price
    }
    last_bar.close = match.unit_price
    last_bar.volume += match.type == 'buymatch' ? match.bid : match.ask
    await last_bar.save()
  } else {
    // TODO FIX! Memory leak on production
    // Create empty bars for the timeframe(s) without trades
    // const emptyBars = []
    // let emptyTime = last_bar_end_time
    // while (emptyTime < match.time.getTime()) {
    //   emptyBars.push({
    //     timeframe,
    //     chain: match.chain,
    //     market: match.market,
    //     time: new Date(emptyTime),
    //     open: last_bar.close,
    //     high: last_bar.close,
    //     low: last_bar.close,
    //     close: last_bar.close,
    //     volume: 0
    //   })
    //   emptyTime += resolution * 1000
    // }

    // if (emptyBars) {
    //   await Bar.insertMany(emptyBars)
    // }

    // Create a new bar for the new timeframe
    await Bar.create({
      timeframe,
      chain: match.chain,
      market: match.market,
      time: new Date(last_bar_end_time),
      open: last_bar.close,
      high: match.unit_price,
      low: match.unit_price,
      close: match.unit_price,
      volume: match.type == 'buymatch' ? match.bid : match.ask
    })

    last_bar.close = match.unit_price
    await last_bar.save()
  }
}

export async function markeSwapBars(swap) {
  console.log('markeSwapBars', swap.chain, swap.time)
  for (const timeframe of Object.keys(resolutions)) {
    await markeSwapBar(timeframe, swap)
  }

  console.log('markeSwapBars done', swap.chain, swap.time)
  //const dbOperations = []
  // Object.keys(resolutions).forEach(timeframe => {
  //   dbOperations.push(markeSwapBar(timeframe, swap))
  // })

  // await Promise.all(dbOperations)
}

function getBarTimes(matchTime, resolutionInSeconds) {
  const resolutionMilliseconds = resolutionInSeconds * 1000 // Преобразование секунд в миллисекунды
  const matchTimeMilliseconds = matchTime.getTime() // Получаем время сделки в миллисекундах
  const barStartTime = Math.floor(matchTimeMilliseconds / resolutionMilliseconds) * resolutionMilliseconds
  const nextBarStartTime = barStartTime + resolutionMilliseconds // Добавляем один интервал к началу текущего бара

  return {
    currentBarStart: new Date(barStartTime), // Возвращаем объект Date для текущего бара
    nextBarStart: new Date(nextBarStartTime), // Возвращаем объект Date для следующего бара
  }
}

export async function markeSwapBar(timeframe, swap) {
  const frame = resolutions[timeframe]
  const { currentBarStart, nextBarStart } = getBarTimes(swap.time, frame)

  const bar = await SwapBar.findOne({
    chain: swap.chain,
    pool: swap.pool,
    timeframe,
    time: {
      $gte: currentBarStart,
      $lt: nextBarStart
    }
  })

  if (!bar) {
    await SwapBar.create({
      timeframe,
      chain: swap.chain,
      pool: swap.pool,
      time: currentBarStart,
      open: swap.sqrtPriceX64,
      high: swap.sqrtPriceX64,
      low: swap.sqrtPriceX64,
      close: swap.sqrtPriceX64,

      volumeA: Math.abs(swap.tokenA),
      volumeB: Math.abs(swap.tokenB),
      volumeUSD: swap.totalUSDVolume,
    })
  } else {
    if (BigInt(bar.high) < BigInt(swap.sqrtPriceX64)) {
      bar.high = swap.sqrtPriceX64
    } else if (BigInt(bar.low) > BigInt(swap.sqrtPriceX64)) {
      bar.low = swap.sqrtPriceX64
    }

    bar.close = swap.sqrtPriceX64

    bar.volumeA += Math.abs(swap.tokenA)
    bar.volumeB += Math.abs(swap.tokenB)
    bar.volumeUSD += swap.totalUSDVolume
    await bar.save()
  }
}

export async function getVolumeFrom(date, market, chain) {
  const day_volume = await Match.aggregate([
    { $match: { chain, market, time: { $gte: new Date(date) } } },
    { $project: { market: 1, value: { $cond: { if: { $eq: ['$type', 'buymatch'] }, then: '$bid', else: '$ask' } } } },
    { $group: { _id: '$market', volume: { $sum: '$value' } } }
  ])

  return day_volume.length == 1 ? day_volume[0].volume : 0
}

export async function getChangeFrom(date, market, chain) {
  const date_deal = await Match.findOne({ chain, market, time: { $gte: new Date(date) } }, {}, { sort: { time: 1 } })
  const last_deal = await Match.findOne({ chain, market }, {}, { sort: { time: -1 } })

  if (date_deal) {
    const price_before = date_deal.unit_price
    const price_after = last_deal.unit_price

    return ((price_after - price_before) / price_before) * 100
  } else {
    return 0
  }
}
