import { getRequestConfig } from 'next-intl/server';

/**
 * next-intl のサーバ設定。M1 では ja 固定、M3 で en 切替を有効化予定。
 */
export default getRequestConfig(async () => {
  const locale = 'ja';
  const messages = (await import(`./${locale}.json`)).default;
  return {
    locale,
    messages,
    timeZone: 'Asia/Tokyo',
  };
});
