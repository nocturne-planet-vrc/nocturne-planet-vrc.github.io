UPDATE settings SET value=json_set(value,'$.about','Nocturne Planetは、自作プラネタリウムで星空解説・キャスト接客・歌唱ライブを楽しめるVRChatイベントです。')
WHERE key='site' AND json_extract(value,'$.about')='自作プラネタリウムの星空の下で、星を学び、キャストと話し、歌を楽しむ。Nocturne Planetは、星空解説・キャスト接客・歌唱ライブを楽しめるVRChatイベントです。';
