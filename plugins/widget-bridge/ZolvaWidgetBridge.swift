import Foundation
import WidgetKit
import React

@objc(ZolvaWidgetBridge)
class ZolvaWidgetBridge: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(reloadAllTimelines:rejecter:)
  func reloadAllTimelines(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    if #available(iOS 14.0, *) {
      WidgetCenter.shared.reloadAllTimelines()
      resolve(true)
    } else {
      reject("unsupported_ios", "iOS 14+ required", nil)
    }
  }
}
