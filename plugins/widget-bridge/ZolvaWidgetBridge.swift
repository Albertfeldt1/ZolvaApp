import Foundation
import WidgetKit
import React

@objc(ZolvaWidgetBridge)
class ZolvaWidgetBridge: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(containerPath:rejecter:)
  func containerPath(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let groupId = "group.io.zolva.app"
    guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId) else {
      reject("no_app_group", "App Group container not found", nil)
      return
    }
    resolve(url.path)
  }

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
