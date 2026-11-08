# Address checks for the mailer.
class Mailer
  ADDRESS = /\A[\w+\-.]+@[a-z\d\-]+(\.[a-z\d\-]+)*\.[a-z]+\z/i
  HEADER = %r{^(?<name>[A-Za-z-]+):\s*(?<value>.*)$}

  def valid?(address)
    ADDRESS.match?(address)
  end

  def headers(raw)
    raw.scan(HEADER)
  end
end
