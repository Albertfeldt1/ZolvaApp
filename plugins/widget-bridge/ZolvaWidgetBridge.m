#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ZolvaWidgetBridge, NSObject)

RCT_EXTERN_METHOD(containerPath:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(reloadAllTimelines:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
