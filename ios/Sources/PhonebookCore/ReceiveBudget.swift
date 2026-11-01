public enum ReceiveBudget {
  public static func admits(used: Int, incoming: Int, limit: Int) -> Bool {
    used >= 0 && incoming >= 0 && limit >= used && incoming <= limit - used
  }
}
