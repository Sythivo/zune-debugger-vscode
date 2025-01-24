local signal = require("./signal");

local test_something = 0;

local function varvarvar(...)
    local a, b, c = ...;
    print(a, b, c);
    print(test_something);
end

varvarvar("b", "123", 33);
local test_of_something_long = 0;
local eee = {};
local abc = {[eee] = 2}

local b = signal.new();

b:Connect(function(a: number)
    print(a);
end);

b:Fire({a = {b = {c = { value = "short string"}}}});

pcall(function()
    error("handled test");
end);

print("pressed");

local a = 1;
local c = "abc";

print("two");
print(a, c);

local function main(a: number)
    local bc = "";
    print(a);
    print(bc);
end

main(2);
