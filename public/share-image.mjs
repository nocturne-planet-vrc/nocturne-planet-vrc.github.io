export const defaultShareImage={path:'/assets/share-banner-238aedb41e86.png',mime:'image/png',width:2000,height:1125};
export const shareImagePath=value=>value?'/api/images/'+encodeURIComponent(value):defaultShareImage.path;
